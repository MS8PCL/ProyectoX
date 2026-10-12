using System.IO.Compression;
using System.Text;
using System.Text.Json;

namespace ProyectoX.Installer;

public sealed record InstallerOptions(string NetworkRoot, bool ReadOnly, string OperationalRole);

/// <summary>Instala en disco local; la carpeta de datos, local o UNC, solo se consulta.</summary>
public sealed class InstallerEngine
{
    private const long MaximumBytes = 1024L * 1024 * 1024;
    private const int MaximumEntries = 20_000;
    // Nombres completos reservados en cualquier nivel; no incluye librerías de runtimes.
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "config.json", "state.json", "state.backup.json", "commit.pending", ".write.lock",
        "runtime-data", "documents", "pocketbase-storage"
    };
    private readonly Func<string, bool> networkDirectoryExists;

    public InstallerEngine(Func<string, bool>? networkDirectoryExists = null)
    {
        this.networkDirectoryExists = networkDirectoryExists ?? Directory.Exists;
    }

    /// <summary>Admite UNC ordinarias y elimina separadores finales, sin resolver rutas relativas.</summary>
    public static string NormalizeUnc(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (!path.StartsWith(@"\\", StringComparison.Ordinal) ||
            path.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            path.StartsWith(@"\\.\", StringComparison.Ordinal))
            throw new ArgumentException("Se requiere una ruta UNC ordinaria: \\\\servidor\\recurso.", nameof(path));

        var normalized = path.TrimEnd('\\');
        var parts = normalized[2..].Split('\\');
        if (parts.Length < 2 || parts.Any(part => !IsSafeSegment(part)))
            throw new ArgumentException("La ruta UNC contiene componentes inválidos o carece de servidor/recurso.", nameof(path));
        return normalized;
    }

    /// <summary>Admite UNC o rutas Windows con unidad absoluta, nunca relativas ni de dispositivo.</summary>
    public static string NormalizeDataRoot(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return NormalizeUnc(path);
        var normalized = path.Replace('/', '\\');
        if (normalized.Length < 3 || !char.IsAsciiLetter(normalized[0]) || normalized[1] != ':' || normalized[2] != '\\')
            throw new ArgumentException(@"Seleccione una ruta absoluta de datos: local (G:\Datos) o UNC (\\servidor\recurso).", nameof(path));
        if (normalized.Length == 3) return normalized;
        normalized = normalized.TrimEnd('\\');
        if (normalized[3..].Split('\\').Any(part => !IsSafeSegment(part)))
            throw new ArgumentException("La ruta local contiene componentes inválidos.", nameof(path));
        return normalized;
    }

    public static string BuildConfiguration(InstallerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var networkRoot = NormalizeDataRoot(options.NetworkRoot);
        if (options.OperationalRole is not ("rrhh" or "it" or "admin"))
            throw new ArgumentException("El rol debe ser rrhh, it o admin.", nameof(options));
        return JsonSerializer.Serialize(new
        {
            networkRoot,
            readOnly = options.ReadOnly,
            operationalRole = options.OperationalRole
        }, new JsonSerializerOptions { WriteIndented = true });
    }

    /// <summary>
    /// Extrae con límites a un staging hermano y publica mediante Directory.Move.
    /// El stream pertenece al llamador. No sobrescribe instalaciones ni escribe en la carpeta de datos.
    /// </summary>
    public void Install(Stream payload, string destination, InstallerOptions options)
    {
        ArgumentNullException.ThrowIfNull(payload);
        var configuration = BuildConfiguration(options);
        var dataRoot = NormalizeDataRoot(options.NetworkRoot);
        if (!networkDirectoryExists(dataRoot))
            throw new IOException("La carpeta de datos local o UNC no existe o no está accesible; no se utilizará un destino alternativo.");
        var target = ValidateDestination(destination);
        if (!dataRoot.StartsWith(@"\\", StringComparison.Ordinal) && OperatingSystem.IsWindows())
        {
            var data = Path.GetFullPath(dataRoot).TrimEnd('\\');
            var app = target.TrimEnd('\\');
            if (string.Equals(data, app, StringComparison.OrdinalIgnoreCase) ||
                app.StartsWith(data + "\\", StringComparison.OrdinalIgnoreCase) ||
                data.StartsWith(app + "\\", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Las carpetas de datos y de instalación deben ser independientes: no pueden coincidir ni estar una dentro de la otra.");
        }
        EnsureEmptyOrMissing(target);
        var parent = Path.GetDirectoryName(target)!;
        if (!Directory.Exists(parent))
            throw new DirectoryNotFoundException("El directorio padre local debe existir.");
        var staging = Path.Combine(parent, ".proyectox-staging-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            Extract(payload, staging);
            File.WriteAllText(Path.Combine(staging, "config.json"), configuration, new UTF8Encoding(false));
            Promote(staging, target);
        }
        finally
        {
            // Solo se elimina el staging que creó este intento, nunca el destino ni su reserva.
            if (Directory.Exists(staging))
                Directory.Delete(staging, recursive: true);
        }
    }

    private static bool IsSafeSegment(string part)
    {
        if (string.IsNullOrWhiteSpace(part) || part is "." or ".." ||
            part.EndsWith('.') || part.EndsWith(' ') ||
            part.Any(c => c < 32 || "<>:\"/\\|?*".Contains(c)))
            return false;
        var stem = part.Split('.')[0];
        return !new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }
            .Contains(stem, StringComparer.OrdinalIgnoreCase);
    }

    private static string ValidateDestination(string destination)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(destination);
        if (!Path.IsPathFullyQualified(destination) || destination.StartsWith(@"\", StringComparison.Ordinal) ||
            destination.StartsWith("//", StringComparison.Ordinal))
            throw new ArgumentException("El destino debe ser una ruta local absoluta, no UNC ni de dispositivo.", nameof(destination));
        var target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(destination));
        var root = Path.GetPathRoot(target)!;
        if (string.Equals(target, Path.TrimEndingDirectorySeparator(root), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("No se puede instalar en la raíz de una unidad.", nameof(destination));
        if (OperatingSystem.IsWindows() && new DriveInfo(root).DriveType == DriveType.Network)
            throw new ArgumentException("El destino no puede estar en una unidad de red.", nameof(destination));
        // Evita que enlaces/junctions existentes desvíen la escritura a otra ubicación.
        for (string? current = target; current is not null; current = Path.GetDirectoryName(current))
        {
            if (Path.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("El destino y sus padres no pueden ser enlaces ni junctions.");
        }
        return target;
    }

    private static void EnsureEmptyOrMissing(string target)
    {
        if (File.Exists(target) || (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any()))
            throw new IOException("El destino está ocupado; no se sobrescribirá ninguna instalación, configuración ni dato.");
    }

    private static void Extract(Stream payload, string staging)
    {
        using var archive = new ZipArchive(payload, ZipArchiveMode.Read, leaveOpen: true);
        if (archive.Entries.Count > MaximumEntries)
            throw new InvalidDataException("El ZIP supera las 20000 entradas.");
        long total = 0;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var executable = false;
        var buffer = new byte[81920];
        foreach (var entry in archive.Entries)
        {
            var name = entry.FullName.Replace('\\', '/');
            var isDirectory = name.EndsWith('/');
            var relative = isDirectory ? name[..^1] : name;
            var parts = relative.Split('/');
            if (parts.Any(part => !IsSafeSegment(part)) || !seen.Add(relative) ||
                ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000 ||
                (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("El ZIP contiene rutas inseguras, duplicadas o enlaces.");
            if (parts.Any(ReservedNames.Contains))
                throw new InvalidDataException("El ZIP contiene configuración o datos de ejecución reservados.");
            if (entry.Length > MaximumBytes - total)
                throw new InvalidDataException("El ZIP supera 1 GiB descomprimido.");
            var output = Path.Combine(staging, Path.Combine(parts));
            if (isDirectory)
            {
                if (entry.Length != 0)
                    throw new InvalidDataException("Una carpeta del ZIP contiene datos.");
                Directory.CreateDirectory(output);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            using var input = entry.Open();
            using var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            long written = 0;
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                if (count > MaximumBytes - total || count > entry.Length - written)
                    throw new InvalidDataException("El tamaño real del ZIP excede el límite o el tamaño declarado.");
                file.Write(buffer, 0, count);
                total += count;
                written += count;
            }
            if (written != entry.Length)
                throw new InvalidDataException("Entrada ZIP truncada.");
            if (relative == "ProyectoX.Desktop.exe")
                executable = true;
        }
        if (!executable)
            throw new InvalidDataException("Falta ProyectoX.Desktop.exe en la raíz del ZIP.");
    }

    private static void Promote(string staging, string target)
    {
        ValidateDestination(target);
        EnsureEmptyOrMissing(target);
        string? reservation = null;
        try
        {
            if (Directory.Exists(target))
            {
                var candidate = Path.Combine(Path.GetDirectoryName(target)!, ".proyectox-empty-" + Guid.NewGuid().ToString("N"));
                Directory.Move(target, candidate);
                reservation = candidate;
                // La comprobación inicial no basta: otro proceso pudo escribir antes del movimiento.
                EnsureEmptyOrMissing(reservation);
            }
            // Move falla si alguien creó el destino mientras preparábamos la publicación.
            Directory.Move(staging, target);
        }
        catch (Exception error)
        {
            if (reservation is not null && Directory.Exists(reservation))
            {
                try
                {
                    Directory.Move(reservation, target);
                }
                catch (Exception restoreError) when (restoreError is IOException or UnauthorizedAccessException)
                {
                    throw new IOException($"No se pudo restaurar el destino; su contenido se conserva en {reservation}.",
                        new AggregateException(error, restoreError));
                }
            }
            throw;
        }
        if (reservation is not null)
        {
            // Nunca borrar recursivamente: si alguien escribió en la reserva, se conserva.
            try { Directory.Delete(reservation, recursive: false); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
