using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace ProyectoX.Desktop;

internal sealed record DesktopConfiguration(string NetworkRoot, bool ReadOnly, string OperationalRole)
{
    public static bool TryLoad(out DesktopConfiguration? configuration, out string problem)
    {
        configuration = null;
        problem = "Falta config.json o no se puede leer. No se ha creado ningún almacenamiento.";
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "config.json")));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("networkRoot", out var networkRoot) || networkRoot.ValueKind != JsonValueKind.String ||
                !root.TryGetProperty("readOnly", out var readOnly) ||
                readOnly.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                problem = "config.json debe especificar networkRoot (ruta absoluta) y readOnly (booleano).";
                return false;
            }
            var path = networkRoot.GetString();
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || !Directory.Exists(path))
            {
                problem = "networkRoot debe ser una ruta absoluta a un directorio ya existente y accesible. No se crea ni se usa otra ruta.";
                return false;
            }
            // This is an operational UI role, not an authentication boundary. Windows ACLs protect the share.
                        var role = root.TryGetProperty("operationalRole", out var configuredRole) && configuredRole.ValueKind == JsonValueKind.String
                            ? configuredRole.GetString() : "rrhh";
                        if (role is not ("rrhh" or "it" or "admin"))
                        {
                            problem = "operationalRole debe ser rrhh, it o admin. Los permisos reales dependen de las ACL de Windows.";
                            return false;
                        }
                        configuration = new DesktopConfiguration(Path.GetFullPath(path), readOnly.GetBoolean(), role);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException or NotSupportedException)
        {
            HostLog.Event("configuration_unavailable", exception);
            return false;
        }
    }
}

internal sealed class ConfigurationWindow : Window
{
    public ConfigurationWindow(string problem)
    {
        Title = "Proyecto X — Configuración necesaria";
        Width = 660;
        Height = 410;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var panel = new StackPanel { Margin = new Thickness(28) };
        panel.Children.Add(new TextBlock { Text = problem, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 18) });
        panel.Children.Add(new TextBlock
        {
            Text = "Cree manualmente config.json junto al ejecutable, no en el directorio de trabajo. Elija explícitamente un directorio compartido existente. Para probar, cree usted un directorio de prueba y configure su ruta absoluta.\n\nEjemplo (sustituya la ruta):\n{\n  \"networkRoot\": \"C:\\\\RutaElegidaExistente\",\n  \"readOnly\": false\n}\n\nReinicie después de configurar. Esta ventana no guarda archivos ni crea directorios. El acceso depende de las ACL de Windows; no hay usuarios ni roles propios.",
            TextWrapping = TextWrapping.Wrap
        });
        var close = new Button { Content = "Cerrar", HorizontalAlignment = HorizontalAlignment.Right, Padding = new Thickness(18, 6, 18, 6), Margin = new Thickness(0, 20, 0, 0) };
        close.Click += (_, _) => Close();
        panel.Children.Add(close);
        Content = panel;
    }
}
