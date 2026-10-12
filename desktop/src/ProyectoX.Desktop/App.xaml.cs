using System.Windows;

namespace ProyectoX.Desktop;

public partial class App : Application
{
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        MainWindow = new Window
        {
            Title = "Proyecto X", Width = 660, Height = 240,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Content = new System.Windows.Controls.TextBlock
            {
                Text = "Comprobando configuración y acceso al almacenamiento…",
                Margin = new Thickness(28), TextWrapping = TextWrapping.Wrap
            }
        };
        var startupWindow = MainWindow;
        var closed = false;
        startupWindow.Closed += (_, _) => closed = true;
        startupWindow.Show();
        var result = await Task.Run(() =>
        {
            var valid = DesktopConfiguration.TryLoad(out var configuration, out var problem);
            return (valid, configuration, problem);
        });
        if (closed) return;
        MainWindow = result.valid
            ? new MainWindow(result.configuration!)
            : new ConfigurationWindow(result.problem);
        MainWindow.Show();
        startupWindow.Close();
    }
}
