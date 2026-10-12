using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using ProyectoX.Installer;

// Harness autónomo: no accede a recursos UNC reales ni ejecuta binarios.
// Argumento opcional: ruta al ZIP publicado para validar una instalación self-contained.
internal static class Program
{
    private static readonly InstallerOptions Options = new(@"\\servidor-ficticio\recurso\carpeta\", true, "rrhh");

    private static int Main(string[] args)
    {
        var tests = new (string Name, Action Run)[]
        {
            ("UNC normalizada y JSON con backslashes", Configuration),
            ("UNC inválidas", InvalidUnc),
            ("Roles permitidos y rechazados", Roles),
            ("Red inaccesible sin fallback local", Unavailable),
            ("Instalación en destino inexistente", () => Successful(false)),
            ("Instalación en carpeta vacía", () => Successful(true)),
            ("Destino ocupado y configuración intactos", Occupied),
            ("Destinos relativos, UNC y device rechazados", InvalidDestinations),
            ("Payload corrupto y ejecutable obligatorio", Corrupt),
            ("Traversal, rutas absolutas y backslashes", UnsafePaths),
            ("Configuración y datos runtime reservados", Reserved),
            ("Librerías runtimes y nombres similares permitidos", RuntimeLibraries),
            ("Duplicados, colisiones y enlaces rechazados", Collisions),
            ("Rollback tras extracción parcial", PartialCleanup),
            ("Límites de tamaño y entradas", Limits),
            ("Carrera: destino creado durante extracción", () => DestinationRace(false)),
            ("Carrera: carpeta vacía ocupada durante extracción", () => DestinationRace(true)),
            ("UNC solo consultada, jamás escrita", NetworkReadOnly)
        };
        var failed = 0;
        foreach (var test in tests)
        {
            try { test.Run(); Console.WriteLine($"PASS {test.Name}"); }
            catch (Exception error) { failed++; Console.Error.WriteLine($"FAIL {test.Name}: {error}"); }
        }
        var total = tests.Length;
        if (args.Length > 0)
        {
            total++;
            try
            {
                PublishedPayload(args[0]);
                Console.WriteLine($"PASS ZIP publicado self-contained: {args[0]}");
            }
            catch (Exception error)
            {
                failed++;
                Console.Error.WriteLine($"FAIL ZIP publicado self-contained: {args[0]}: {error}");
            }
        }
        Console.WriteLine($"Resultados: {total - failed}/{total} pruebas correctas.");
        return failed == 0 ? 0 : 1;
    }

    private static void PublishedPayload(string zipPath) => InWorkspace(root =>
    {
        // El ZIP original solo se abre para lectura; toda extracción y limpieza queda en este temporal.
        using var payload = File.OpenRead(zipPath);
        var expectedNetworkRoot = InstallerEngine.NormalizeUnc(Options.NetworkRoot);
        var networkChecks = 0;
        var engine = new InstallerEngine(path =>
        {
            Equal(expectedNetworkRoot, path);
            networkChecks++;
            return true;
        });
        var destination = Target(root);
        engine.Install(payload, destination, Options);
        Equal(1, networkChecks);

        foreach (var name in new[] { "ProyectoX.Desktop.exe", "coreclr.dll", "hostfxr.dll" })
        {
            var file = new FileInfo(Path.Combine(destination, name));
            Check(file.Exists, $"Falta {name} en la raíz del payload publicado.");
            Check(file.Length > 0, $"El archivo {name} está vacío.");
        }

        using var configuration = JsonDocument.Parse(File.ReadAllText(Path.Combine(destination, "config.json")));
        var json = configuration.RootElement;
        Equal(expectedNetworkRoot, json.GetProperty("networkRoot").GetString()!);
        Equal(Options.ReadOnly, json.GetProperty("readOnly").GetBoolean());
        Equal(Options.OperationalRole, json.GetProperty("operationalRole").GetString()!);
        Equal(3, json.EnumerateObject().Count());
        Equal(1, Directory.GetFileSystemEntries(root).Length);
    });

    private static void Configuration()
    {
        Equal(@"\\servidor-ficticio\recurso\carpeta", InstallerEngine.NormalizeUnc(Options.NetworkRoot));
        Equal(@"\\servidor\recurso", InstallerEngine.NormalizeUnc(@"\\servidor\recurso\\"));
        var json = InstallerEngine.BuildConfiguration(Options);
        Check(json.Contains("\\\\\\\\servidor-ficticio", StringComparison.Ordinal), "Los backslashes no están escapados.");
        using var document = JsonDocument.Parse(json);
        Equal(InstallerEngine.NormalizeUnc(Options.NetworkRoot), document.RootElement.GetProperty("networkRoot").GetString()!);
        Check(document.RootElement.GetProperty("readOnly").GetBoolean(), "readOnly incorrecto.");
        Equal("rrhh", document.RootElement.GetProperty("operationalRole").GetString()!);
        Equal(3, document.RootElement.EnumerateObject().Count());
    }

    private static void InvalidUnc()
    {
        foreach (var path in new[] { "", " ", "C:\\local", "/tmp/local", "//server/share", @"\\server", @"\\server\", @"\\\share", @"\\server\\share", @"\\?\UNC\server\share", @"\\.\server\share", @"\\server\share\.", @"\\server\share\..\escape", @"\\server\sh:are", @"\\server\share\bad*", @"\\server\share\bad?", @"\\server\share\bad|", @"\\server\share\bad<", "\\\\server\\share\\bad\"", @"\\server\share/child", @"\\server\share\trailing.", @"\\server\share\trailing ", "\\\\server\\share\\bad\0" })
            Throws<ArgumentException>(() => InstallerEngine.NormalizeUnc(path));
        Throws<ArgumentNullException>(() => InstallerEngine.NormalizeUnc(null!));
    }

    private static void Roles()
    {
        foreach (var role in new[] { "rrhh", "it", "admin" })
        {
            using var json = JsonDocument.Parse(InstallerEngine.BuildConfiguration(Options with { OperationalRole = role, ReadOnly = false }));
            Equal(role, json.RootElement.GetProperty("operationalRole").GetString()!);
            Check(!json.RootElement.GetProperty("readOnly").GetBoolean(), "readOnly false no se conserva.");
        }
        foreach (var role in new[] { "", "RRHH", "user", " it ", null })
            Throws<ArgumentException>(() => InstallerEngine.BuildConfiguration(Options with { OperationalRole = role! }));
        Throws<ArgumentNullException>(() => InstallerEngine.BuildConfiguration(null!));
    }

    private static void Unavailable() => InWorkspace(root =>
    {
        using var zip = Payload();
        Throws<IOException>(() => new InstallerEngine(_ => false).Install(zip, Target(root), Options));
        Equal(0, Directory.GetFileSystemEntries(root).Length);
        using var another = Payload();
        Throws<UnauthorizedAccessException>(() => new InstallerEngine(_ => throw new UnauthorizedAccessException()).Install(another, Target(root), Options));
        Equal(0, Directory.GetFileSystemEntries(root).Length);
    });

    private static void Successful(bool empty) => InWorkspace(root =>
    {
        var target = Target(root);
        if (empty) Directory.CreateDirectory(target);
        using var zip = Payload(("assets/", ""), ("assets/file.bin", "contenido"));
        new InstallerEngine(_ => true).Install(zip, target, Options);
        Equal("binario ficticio", File.ReadAllText(Path.Combine(target, "ProyectoX.Desktop.exe")));
        Equal("contenido", File.ReadAllText(Path.Combine(target, "assets", "file.bin")));
        Equal(InstallerEngine.BuildConfiguration(Options), File.ReadAllText(Path.Combine(target, "config.json")));
        Check(zip.CanRead, "El motor cerró el stream del llamador.");
        Equal(1, Directory.GetFileSystemEntries(root).Length);
    });

    private static void Occupied() => InWorkspace(root =>
    {
        var target = Target(root);
        Directory.CreateDirectory(target);
        var config = Path.Combine(target, "config.json");
        File.WriteAllText(config, "config original");
        File.WriteAllText(Path.Combine(target, "datos.txt"), "datos originales");
        using var zip = Payload();
        Throws<IOException>(() => new InstallerEngine(_ => true).Install(zip, target, Options));
        Equal("config original", File.ReadAllText(config));
        Equal("datos originales", File.ReadAllText(Path.Combine(target, "datos.txt")));
        Equal(2, Directory.GetFileSystemEntries(target).Length);
        var fileTarget = Path.Combine(root, "archivo");
        File.WriteAllText(fileTarget, "original");
        Throws<IOException>(() => new InstallerEngine(_ => true).Install(zip, fileTarget, Options));
        Equal("original", File.ReadAllText(fileTarget));
    });

    private static void InvalidDestinations() => InWorkspace(root =>
    {
        foreach (var destination in new[] { "", "relativo", @"C:relativo", @"\\server\share\install", @"\\?\C:\install", @"\\.\C:\install", "//server/share/install", Path.GetPathRoot(root)! })
        {
            using var zip = Payload();
            Throws<ArgumentException>(() => new InstallerEngine(_ => true).Install(zip, destination, Options));
        }
        Equal(0, Directory.GetFileSystemEntries(root).Length);
    });

    private static void Corrupt() => InWorkspace(root =>
    {
        using var corrupt = new MemoryStream(Encoding.UTF8.GetBytes("no es un ZIP"));
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(corrupt, Target(root), Options));
        using var noExe = Zip(("nested/ProyectoX.Desktop.exe", "falso"));
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(noExe, Target(root), Options));
        using var good = Payload();
        using var truncated = new MemoryStream(good.ToArray()[..20]);
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(truncated, Target(root), Options));
        Equal(0, Directory.GetFileSystemEntries(root).Length);
    });

    private static void UnsafePaths()
    {
        foreach (var name in new[] { "../escape.txt", "a/../../escape.txt", @"..\escape.txt", @"a\..\..\escape.txt", "/absolute", @"\absolute", @"\\server\share\evil", "C:/evil", @"C:\evil", "a//b", "a/./b", "file:stream", "CON.txt", "trailing. ", "bad?.txt" })
            RejectEntry(name);
    }

    private static void Reserved()
    {
        foreach (var reserved in new[]
        {
            "config.json", "state.json", "state.backup.json", "commit.pending", ".write.lock",
            "runtime-data", "documents", "pocketbase-storage"
        })
        {
            foreach (var name in new[]
            {
                reserved,
                $"nested/deep/{reserved}",
                $"nested/deep/{reserved.ToUpperInvariant()}",
                $@"nested\deep\{reserved}",
                $"{reserved}/",
                $"nested/deep/{reserved}/",
                $"nested/deep/{reserved}/child.bin",
                $@"nested\deep\{reserved.ToUpperInvariant()}\child.bin"
            })
                RejectEntry(name);
        }
        RejectEntry("data/state.json");
        RejectEntry(@"data\state.json");
    }

    private static void RuntimeLibraries() => InWorkspace(root =>
    {
        var files = new[]
        {
            "runtimes/win-x64/native/library.dll",
            "nested/runtimes/linux-x64/native/library.so",
            "runtime/library.dll",
            "documents-library/library.dll",
            "assets/state.json.example",
            "assets/state.backup.json.example",
            "assets/runtime-data-template/example.txt",
            "assets/pocketbase-storage-template/example.txt"
        };
        using var zip = Payload(new[] { ("runtimes/", "") }
            .Concat(files.Select(name => (name, "librería ficticia"))).ToArray());
        new InstallerEngine(_ => true).Install(zip, Target(root), Options);
        foreach (var name in files)
            Equal("librería ficticia", File.ReadAllText(Path.Combine(Target(root), name)));
        Equal(1, Directory.GetFileSystemEntries(root).Length);
    });

    private static void Collisions() => InWorkspace(root =>
    {
        foreach (var entries in new[]
        {
            new[] { ("same", "1"), ("SAME", "2") },
            new[] { ("parent", "1"), ("parent/child", "2") }
        })
        {
            using var zip = Payload(entries);
            if (entries[0].Item1 == "same")
                Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(zip, Target(root), Options));
            else
                Throws<IOException>(() => new InstallerEngine(_ => true).Install(zip, Target(root), Options));
            Equal(0, Directory.GetFileSystemEntries(root).Length);
        }
        using var link = new MemoryStream();
        using (var archive = new ZipArchive(link, ZipArchiveMode.Create, true))
        {
            archive.CreateEntry("ProyectoX.Desktop.exe");
            archive.CreateEntry("link").ExternalAttributes = unchecked((int)0xA1FF0000);
        }
        link.Position = 0;
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(link, Target(root), Options));
        Equal(0, Directory.GetFileSystemEntries(root).Length);
    });

    private static void PartialCleanup() => InWorkspace(root =>
    {
        var unrelated = Path.Combine(root, "ajeno.txt");
        File.WriteAllText(unrelated, "conservar");
        Directory.CreateDirectory(Target(root));
        using var zip = Payload(("assets/ok.txt", "extraído antes del error"), ("../escape", "prohibido"));
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(zip, Target(root), Options));
        Check(Directory.Exists(Target(root)), "Se eliminó el destino vacío preexistente.");
        Equal(0, Directory.GetFileSystemEntries(Target(root)).Length);
        Equal("conservar", File.ReadAllText(unrelated));
        Equal(2, Directory.GetFileSystemEntries(root).Length);
    });

    private static void Limits() => InWorkspace(root =>
    {
        using var many = new MemoryStream();
        using (var archive = new ZipArchive(many, ZipArchiveMode.Create, true))
            for (var i = 0; i < 20_001; i++) archive.CreateEntry($"file-{i}");
        many.Position = 0;
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(many, Target(root), Options));
        using var zip = Payload();
        var bytes = zip.ToArray();
        var patched = false;
        for (var i = 0; i <= bytes.Length - 46; i++)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(i, 4)) != 0x02014B50) continue;
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(i + 24, 4), 1024U * 1024 * 1024 + 1);
            patched = true;
            break;
        }
        Check(patched, "No se encontró el directorio central.");
        using var oversized = new MemoryStream(bytes);
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(oversized, Target(root), Options));
        Equal(0, Directory.GetFileSystemEntries(root).Length);
    });

    private static void DestinationRace(bool empty) => InWorkspace(root =>
    {
        var target = Target(root);
        if (empty) Directory.CreateDirectory(target);
        using var zip = Payload();
        using var racing = new OnReadStream(zip.ToArray(), () =>
        {
            Directory.CreateDirectory(target);
            File.WriteAllText(Path.Combine(target, "config.json"), "creado por otro proceso");
        });
        Throws<IOException>(() => new InstallerEngine(_ => true).Install(racing, target, Options));
        Equal("creado por otro proceso", File.ReadAllText(Path.Combine(target, "config.json")));
        Equal(1, Directory.GetFileSystemEntries(target).Length);
        Equal(1, Directory.GetFileSystemEntries(root).Length);
    });

    private static void NetworkReadOnly() => InWorkspace(root =>
    {
        var calls = new List<string>();
        using var zip = Payload();
        new InstallerEngine(path => { calls.Add(path); return true; }).Install(zip, Target(root), Options);
        Equal(1, calls.Count);
        Equal(@"\\servidor-ficticio\recurso\carpeta", calls[0]);
        // La UNC es ficticia: la instalación solo funciona si todas las escrituras son locales.
        Equal(1, Directory.GetFileSystemEntries(root).Length);
    });

    private static void RejectEntry(string name) => InWorkspace(root =>
    {
        using var zip = Payload((name, name.EndsWith('/') || name.EndsWith('\\') ? "" : "malicioso"));
        Throws<InvalidDataException>(() => new InstallerEngine(_ => true).Install(zip, Target(root), Options));
        Equal(0, Directory.GetFileSystemEntries(root).Length);
    });

    private static MemoryStream Payload(params (string Name, string Content)[] entries) =>
        Zip(new[] { ("ProyectoX.Desktop.exe", "binario ficticio") }.Concat(entries).ToArray());

    private static MemoryStream Zip(params (string Name, string Content)[] entries)
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, true))
            foreach (var entry in entries)
            {
                using var writer = new StreamWriter(archive.CreateEntry(entry.Name).Open(), new UTF8Encoding(false));
                writer.Write(entry.Content);
            }
        stream.Position = 0;
        return stream;
    }

    private static string Target(string root) => Path.Combine(root, "instalacion");

    private static void InWorkspace(Action<string> action)
    {
        var root = Path.Combine(Path.GetTempPath(), "proyectox-installer-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try { action(root); }
        finally { Directory.Delete(root, true); }
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Equal<T>(T expected, T actual) =>
        Check(EqualityComparer<T>.Default.Equals(expected, actual), $"Esperado: {expected}; recibido: {actual}");

    private static void Throws<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new InvalidOperationException($"Se esperaba {typeof(T).Name}.");
    }

    private sealed class OnReadStream(byte[] bytes, Action onRead) : MemoryStream(bytes)
    {
        private bool fired;
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (!fired) { fired = true; onRead(); }
            return base.Read(buffer, offset, count);
        }
        public override int Read(Span<byte> buffer)
        {
            if (!fired) { fired = true; onRead(); }
            return base.Read(buffer);
        }
    }
}
