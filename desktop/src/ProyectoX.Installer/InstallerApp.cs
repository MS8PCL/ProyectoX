using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ProyectoX.Installer;

internal sealed class InstallerApp : Application
{
    [STAThread]
    public static void Main() => new InstallerApp().Run(new InstallerWindow());
}

internal sealed class InstallerWindow : Window
{
    private readonly TextBox networkRoot = new() { MinWidth = 400 };
    private readonly TextBox destination = new();
    private readonly CheckBox readOnly = new() { Content = "Solo lectura (no permite guardar cambios)", IsChecked = true };
    private readonly ComboBox role = new() { ItemsSource = new[] { "rrhh", "it", "admin" }, SelectedIndex = 0 };
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 16, 0, 12) };
    private readonly Button install = new() { Content = "Instalar", Padding = new Thickness(20, 8, 20, 8) };
    private readonly Button launch = new() { Content = "Abrir Proyecto X", Padding = new Thickness(20, 8, 20, 8), Visibility = Visibility.Collapsed };
    private readonly StackPanel form = new();
    private bool busy;
    private string? installedDirectory;

    public InstallerWindow()
    {
        Title = "Proyecto X — Instalador";
        Width = 720;
        Height = 640;
        MinWidth = 600;
        MinHeight = 520;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        destination.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ProyectoX");
        var panel = new StackPanel { Margin = new Thickness(28) };
        panel.Children.Add(new TextBlock { Text = "Instalar Proyecto X", FontSize = 25, Margin = new Thickness(0, 0, 0, 16) });
        panel.Children.Add(new TextBlock
        {
            Text = "Instalación local para este usuario, sin permisos de administrador. Incluye .NET 8; requiere Microsoft Edge WebView2 Runtime. Los datos permanecen en la carpeta local o UNC elegida.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 18)
        });
        form.Children.Add(Label("Carpeta existente para los datos (local o UNC)"));
        networkRoot.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "NetworkRoot");
        form.Children.Add(Row(networkRoot, "Explorar…", "BrowseNetwork", (_, _) => Browse(networkRoot, true)));
        form.Children.Add(Label("Carpeta local de instalación (nueva o vacía)"));
        destination.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "InstallDirectory");
        form.Children.Add(Row(destination, "Explorar…", "BrowseLocal", (_, _) => Browse(destination, false)));
        readOnly.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "ReadOnly");
        role.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "OperationalRole");
        status.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "Status");
        form.Children.Add(readOnly);
        form.Children.Add(Label("Rol operativo"));
        form.Children.Add(role);
        form.Children.Add(new TextBlock
        {
            Text = "El rol y «Solo lectura» no sustituyen los permisos de Windows (ACL). El instalador comprueba que la carpeta de datos existe, pero no escribe en ella ni comprueba permisos de escritura. Datos e instalación deben estar en carpetas independientes. No crea carpetas de datos ni cambia de destino si falla la red.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0)
        });
        panel.Children.Add(form);
        panel.Children.Add(status);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        install.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, "Install");
        install.Click += Install;
        launch.Click += (_, _) => Launch();
        var close = new Button { Content = "Cerrar", Padding = new Thickness(20, 8, 20, 8), Margin = new Thickness(12, 0, 0, 0) };
        close.Click += (_, _) => Close();
        buttons.Children.Add(install);
        buttons.Children.Add(launch);
        buttons.Children.Add(close);
        panel.Children.Add(buttons);
        Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Closing += (_, e) =>
        {
            if (busy)
            {
                e.Cancel = true;
                status.Text = "Espere a que termine la instalación. Una comprobación SMB puede tardar si la red no responde.";
            }
        };
    }

    private static TextBlock Label(string text) => new() { Text = text, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 6) };

    private static DockPanel Row(TextBox field, string caption, string automationId, RoutedEventHandler click)
    {
        var row = new DockPanel { Margin = new Thickness(0, 0, 0, 12) };
        var button = new Button { Content = caption, Margin = new Thickness(10, 0, 0, 0), Padding = new Thickness(12, 5, 12, 5) };
        button.SetValue(System.Windows.Automation.AutomationProperties.AutomationIdProperty, automationId);
        button.Click += click;
        DockPanel.SetDock(button, Dock.Right);
        row.Children.Add(button);
        row.Children.Add(field);
        return row;
    }

    private void Browse(TextBox field, bool network)
    {
        var dialog = new OpenFolderDialog { Title = network ? "Seleccione una carpeta de datos local o UNC" : "Seleccione una carpeta local vacía", Multiselect = false };
        if (dialog.ShowDialog(this) == true)
        {
            field.Text = dialog.FolderName;
        }
    }

    private async void Install(object sender, RoutedEventArgs e)
    {
        if (busy) return;
        var options = new InstallerOptions(networkRoot.Text.Trim(), readOnly.IsChecked == true, (string)role.SelectedItem);
        var target = destination.Text.Trim();
        try
        {
            InstallerEngine.BuildConfiguration(options);
            if (!Path.IsPathFullyQualified(target) || target.StartsWith(@"\", StringComparison.Ordinal))
                throw new ArgumentException("Seleccione una carpeta local absoluta para instalar la aplicación.");
            busy = true;
            install.IsEnabled = false;
            form.IsEnabled = false;
            status.Text = "Comprobando WebView2, acceso al recurso e instalando… No se escribirá en la carpeta de datos.";
            await Task.Run(() =>
            {
                try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
                catch (WebView2RuntimeNotFoundException)
                {
                    throw new InvalidOperationException("Falta WebView2 Runtime. Instálelo desde https://developer.microsoft.com/microsoft-edge/webview2 y vuelva a ejecutar este instalador.");
                }
                // Solo se crea el padre local por defecto. Nunca se crea la UNC ni un destino alternativo.
                var defaultParent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs");
                if (string.Equals(Path.GetDirectoryName(Path.GetFullPath(target)), defaultParent, StringComparison.OrdinalIgnoreCase))
                    Directory.CreateDirectory(defaultParent);
                using var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("ProyectoX.Installer.Payload.zip")
                    ?? throw new InvalidDataException("El instalador no contiene el paquete de la aplicación.");
                new InstallerEngine().Install(payload, target, options);
            });
            installedDirectory = Path.GetFullPath(target);
            var shortcut = TryCreateShortcut(installedDirectory);
            status.Text = "Instalación completada. La configuración está guardada junto al ejecutable. No se ha modificado la carpeta de datos elegida."
                + (shortcut ? " Se ha creado un acceso en el menú Inicio." : " No se pudo crear el acceso del menú Inicio; puede abrir el ejecutable en la carpeta elegida.");
            install.Visibility = Visibility.Collapsed;
            launch.Visibility = Visibility.Visible;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or NotSupportedException or COMException)
        {
            status.Text = "No se pudo completar la instalación: " + error.Message;
            install.IsEnabled = true;
            form.IsEnabled = true;
        }
        finally { busy = false; }
    }

    private static bool TryCreateShortcut(string directory)
    {
        object? shell = null;
        object? shortcut = null;
        try
        {
            var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException();
            shell = Activator.CreateInstance(type)!;
            var folder = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var shortcutPath = Path.Combine(folder, "Proyecto X.lnk");
            // No reemplazar un acceso existente que puede apuntar a una instalación anterior.
            if (File.Exists(shortcutPath)) return false;
            Directory.CreateDirectory(folder);
            shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath })!;
            shortcut.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(directory, "ProyectoX.Desktop.exe") });
            shortcut.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { directory });
            shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            return true;
        }
        catch (Exception error) when (error is COMException or IOException or UnauthorizedAccessException or TargetInvocationException or InvalidOperationException)
        {
            return false;
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private void Launch()
    {
        try
        {
            Process.Start(new ProcessStartInfo(Path.Combine(installedDirectory!, "ProyectoX.Desktop.exe")) { WorkingDirectory = installedDirectory!, UseShellExecute = true });
            Close();
        }
        catch (Exception error) when (error is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            status.Text = "La aplicación está instalada, pero no se pudo abrir: " + error.Message;
        }
    }
}
