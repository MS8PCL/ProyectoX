using System.IO;
using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using System.Reflection;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using ProyectoX.Storage;

namespace ProyectoX.Desktop;

internal sealed class MainWindow : Window
{
    private const string Origin = "https://proyectox.local";
    private readonly DesktopConfiguration configuration;
    private readonly WebView2 browser = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim requests = new(1, 1);
    // Native actions wait on the user (save dialog, confirmation). They are serialized among
    // themselves but hold `requests` only while reading the store, so autosaves and polling
    // keep flowing instead of timing out behind an open dialog.
    private readonly SemaphoreSlim nativeActions = new(1, 1);
    private readonly Dictionary<string, string> resources;
    private DesktopBridge? bridge;
        private readonly List<string> openedDocumentDirectories = [];
    private bool initialized;
    private bool closed;

    public MainWindow(DesktopConfiguration configuration)
    {
        this.configuration = configuration;
        Title = configuration.ReadOnly ? "Proyecto X — Solo lectura" : "Proyecto X";
        Width = 1280;
        Height = 850;
        MinWidth = 800;
        MinHeight = 560;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Content = browser;
        resources = Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Where(name => name.StartsWith("ProyectoX.Ui/", StringComparison.Ordinal))
            .ToDictionary(name => "/" + name["ProyectoX.Ui/".Length..].Replace('\\', '/'), name => name, StringComparer.Ordinal);
        Loaded += InitializeAsync;
        Closed += (_, _) =>
        {
            closed = true;
            lifetime.Cancel();
            browser.Dispose();
            foreach (var directory in openedDocumentDirectories)
            {
                try { Directory.Delete(directory, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            // Pending bridge handlers may still release the semaphore after closing.
        };
    }

    private async void InitializeAsync(object sender, RoutedEventArgs e)
    {
        if (initialized) return;
        initialized = true;
        try
        {
            // Recheck before constructing storage; never create the configured business root.
            bridge = await Task.Run(() =>
                CreateBridge(configuration), lifetime.Token);
            if (closed) return;
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData) || !Path.IsPathFullyQualified(localAppData))
                throw new InvalidOperationException("Local application data is unavailable.");
            var inspect = Environment.GetEnvironmentVariable("PROYECTOX_INSPECT_UI") == "1";
            var userData = Path.Combine(localAppData, "ProyectoX", inspect ? "WebView2-inspection" : "WebView2");
            var options = inspect
                ? new CoreWebView2EnvironmentOptions("--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1")
                : null;
            var environment = await CoreWebView2Environment.CreateAsync(null, userData, options);
            if (closed) return;
            await browser.EnsureCoreWebView2Async(environment);
            if (closed) return;
            var core = browser.CoreWebView2;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
#if !DEBUG
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
#endif
            core.NavigationStarting += (_, args) => args.Cancel = !IsTrustedSource(args.Uri);
            core.FrameNavigationStarting += (_, args) => args.Cancel = true;
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.PermissionRequested += (_, args) =>
            {
                args.State = CoreWebView2PermissionState.Deny;
                args.Handled = true;
            };
            core.DownloadStarting += HandleBrowserDownload;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeResource;
            core.WebMessageReceived += ReceiveMessageAsync;
            core.Navigate(Origin + "/index.html");
        }
        catch (Exception exception)
        {
            HostLog.Event("host_initialization_failed", exception);
            if (closed) return;
            browser.Dispose();
            Content = new TextBlock
            {
                Margin = new Thickness(32), TextWrapping = TextWrapping.Wrap,
                Text = "No se ha podido iniciar Proyecto X. Compruebe que Microsoft Edge WebView2 Runtime está instalado, que el directorio configurado existe y que tiene permisos de Windows para acceder a él y al perfil local de WebView2. No se ha elegido otro almacenamiento. Cierre la ventana y vuelva a intentarlo."
            };
        }
    }

    private static bool IsTrustedSource(string source) =>
        Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.Host == "proyectox.local" && uri.IsDefaultPort &&
        uri.UserInfo.Length == 0 && uri.GetLeftPart(UriPartial.Authority) == Origin;

    private void ServeResource(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        try
        {
            if (!IsTrustedSource(args.Request.Uri) || args.Request.Method != "GET")
            {
                Respond(args, 403, "Forbidden", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Request blocked."));
                return;
            }
            var uri = new Uri(args.Request.Uri);
            var path = Uri.UnescapeDataString(uri.AbsolutePath);
            if (path == "/") path = "/index.html";
            if (path.Contains('\\') || path.Contains('\0') || path.Split('/').Any(segment => segment is "." or ".."))
            {
                Respond(args, 400, "Bad Request", "text/plain; charset=utf-8", []);
                return;
            }
            if (resources.TryGetValue(path, out var resource))
            {
                using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource);
                if (stream is not null)
                {
                    using var buffer = new MemoryStream();
                    stream.CopyTo(buffer);
                    Respond(args, 200, "OK", ContentType(path), buffer.ToArray());
                    return;
                }
            }
            if (path == "/index.html")
            {
                const string fallback = "<!doctype html><html lang='es'><meta charset='utf-8'><title>Proyecto X</title><body><h1>Interfaz no disponible</h1><p>Compile el frontend original en modo desktop y vuelva a compilar el host. La interfaz debe quedar embebida en el ejecutable; no se utiliza un servidor ni una página remota.</p></body></html>";
                Respond(args, 200, "OK", "text/html; charset=utf-8", Encoding.UTF8.GetBytes(fallback));
                return;
            }
            Respond(args, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Resource not found."));
        }
        catch (Exception exception)
        {
            HostLog.Event("resource_request_failed", exception);
            Respond(args, 500, "Internal Server Error", "text/plain; charset=utf-8", []);
        }
    }

    private void Respond(CoreWebView2WebResourceRequestedEventArgs args, int status, string reason, string mime, byte[] bytes)
    {
        const string policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
        var headers = $"Content-Type: {mime}\r\nContent-Security-Policy: {policy}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer";
        // WebView2 consumes the response stream asynchronously; do not dispose it here.
        args.Response = browser.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(bytes, writable: false), status, reason, headers);
    }

    private async void ReceiveMessageAsync(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsTrustedSource(args.Source) || bridge is null || closed) return;
        SemaphoreSlim? held = null;
        try
        {
            // Capture the trusted source and message before awaiting; ignore string/non-JSON protocols.
            var message = args.WebMessageAsJson;
            var currentBridge = bridge;
            var request = message.Length <= 1_048_576 ? JsonNode.Parse(message) as JsonObject : null;
            var operation = request?["operation"]?.GetValue<string>();
            var native = operation is "documentAction" or "openMail" or "closeApplication";
            var gate = native ? nativeActions : requests;
            await gate.WaitAsync(lifetime.Token);
            held = gate;
            var response = native
                ? await HandleNativeAsync(request!, currentBridge)
                : await Task.Run(() => currentBridge.HandleAsync(message, lifetime.Token), lifetime.Token);
            if (!closed && browser.CoreWebView2 is { } core && IsTrustedSource(core.Source))
                core.PostWebMessageAsJson(response.ToJsonString());
        }
        catch (OperationCanceledException) { }
        catch (Exception exception)
        {
            HostLog.Event("bridge_delivery_failed", exception);
        }
        finally
        {
            held?.Release();
        }
    }

    private static DesktopBridge CreateBridge(DesktopConfiguration configuration)
    {
        using var windows = WindowsIdentity.GetCurrent();
        var sid = windows.User?.Value ?? throw new InvalidOperationException("Windows identity unavailable.");
        var identity = new DesktopIdentity(sid, "", configuration.OperationalRole, windows.Name);
        var store = new SharedStore(configuration.NetworkRoot, configuration.ReadOnly);
        return new DesktopBridge(store, configuration.NetworkRoot, configuration.ReadOnly, identity);
    }

    private async Task<JsonObject> HandleNativeAsync(JsonObject request, DesktopBridge currentBridge)
    {
        var id = request["id"]?.DeepClone();
        try
        {
            var payload = request["payload"] as JsonObject ?? throw new LegacyApiException("invalid_request", "Falta payload.");
            switch (request["operation"]?.GetValue<string>())
            {
                case "closeApplication":
                    _ = Dispatcher.BeginInvoke(new Action(Close));
                    return DesktopBridge.Success(id, new JsonObject { ["ok"] = true });
                case "openMail":
                    var mail = payload["url"]?.GetValue<string>() ?? "";
                    if (mail.Length > 8192 || mail.Any(char.IsControl) || !Uri.TryCreate(mail, UriKind.Absolute, out var mailUri) || mailUri.Scheme != "mailto")
                        throw new LegacyApiException("invalid_request", "Enlace de correo inválido.");
                    if (MessageBox.Show(this, "¿Abrir el cliente de correo de Windows?", "Proyecto X", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
                        return DesktopBridge.Success(id, new JsonObject { ["cancelled"] = true });
                    Process.Start(new ProcessStartInfo(mail) { UseShellExecute = true });
                    return DesktopBridge.Success(id, new JsonObject { ["ok"] = true });
                case "documentAction":
                    var path = payload["path"]?.GetValue<string>() ?? "";
                    var action = payload["action"]?.GetValue<string>();
                    if (action is not ("open" or "save")) throw new LegacyApiException("invalid_request", "Acción de documento inválida.");
                    PreparedDocument document;
                    await requests.WaitAsync(lifetime.Token);
                    try { document = await Task.Run(() => currentBridge.Documents.PrepareExportAsync(path, lifetime.Token), lifetime.Token); }
                    finally { requests.Release(); }
                    if (closed) throw new OperationCanceledException();
                    var fileName = Path.GetFileName(document.FileName);
                    if (string.IsNullOrWhiteSpace(fileName) || fileName != document.FileName || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                        throw new LegacyApiException("invalid_request", "Nombre de documento inválido.");
                    if (action == "save")
                    {
                        var dialog = new SaveFileDialog { FileName = fileName, OverwritePrompt = true, AddExtension = true };
                        if (dialog.ShowDialog(this) != true) return DesktopBridge.Success(id, new JsonObject { ["cancelled"] = true });
                        var selectedPath = dialog.FileName;
                        await Task.Run(() => File.WriteAllBytes(selectedPath, document.Bytes), lifetime.Token);
                    }
                    else
                    {
                        if (!DocumentApi.CanOpenNatively(fileName))
                            throw new LegacyApiException("unsupported_operation", "Este formato solo se puede guardar, no abrir desde la aplicación.");
                        if (MessageBox.Show(this, "El documento se copiará temporalmente a este equipo y se abrirá con el visor de Windows. ¿Continuar?", "Abrir documento", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
                            return DesktopBridge.Success(id, new JsonObject { ["cancelled"] = true });
                        var directory = Path.Combine(Path.GetTempPath(), "ProyectoX", Guid.NewGuid().ToString("N"));
                        Directory.CreateDirectory(directory);
                        openedDocumentDirectories.Add(directory);
                        var temporaryFile = Path.Combine(directory, fileName);
                        await Task.Run(() => File.WriteAllBytes(temporaryFile, document.Bytes), lifetime.Token);
                        if (closed) throw new OperationCanceledException();
                        Process.Start(new ProcessStartInfo(temporaryFile) { UseShellExecute = true });
                    }
                    return DesktopBridge.Success(id, new JsonObject { ["ok"] = true });
                default:
                    throw new LegacyApiException("unsupported_operation", "Operación no soportada.");
            }
        }
        catch (Exception exception)
        {
            return DesktopBridge.Failure(id, exception);
        }
    }

    private void HandleBrowserDownload(object? sender, CoreWebView2DownloadStartingEventArgs args)
    {
        args.Handled = true;
        // Existing CSV/JSON exporters use blob URLs; never allow remote downloads.
        if (closed || !IsTrustedSource(browser.CoreWebView2.Source) ||
            !args.DownloadOperation.Uri.StartsWith("blob:" + Origin + "/", StringComparison.Ordinal))
        {
            args.Cancel = true;
            return;
        }
        var dialog = new SaveFileDialog { FileName = Path.GetFileName(args.ResultFilePath), OverwritePrompt = true };
        if (dialog.ShowDialog(this) == true) args.ResultFilePath = dialog.FileName;
        else args.Cancel = true;
    }

    private static string ContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" or ".map" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".ico" => "image/x-icon",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        _ => "application/octet-stream"
    };
}
