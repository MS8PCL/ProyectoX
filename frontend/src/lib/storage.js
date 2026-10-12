const LS_KEY = "proyecto_x_v2";

export function isDesktopMode() {
  return typeof window !== "undefined" && !!window.chrome?.webview;
}

export function loadState() {
  if (isDesktopMode()) return null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveState(state) {
  if (isDesktopMode()) return false;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("[storage] saveState failed", err);
    return false;
  }
  return true;
}

export function resetState() {
  if (isDesktopMode()) return;
  localStorage.removeItem(LS_KEY);
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename, rows, columns) {
  const header = columns.map((c) => escapeCsvField(c.label || c.key)).join(",");
  const lines = [header];
  for (const row of rows) {
    const line = columns
      .map((c) => {
        const val =
          typeof c.get === "function" ? c.get(row) : (row[c.key] ?? "");
        return escapeCsvField(String(val ?? ""));
      })
      .join(",");
    lines.push(line);
  }
  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsvField(val) {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
