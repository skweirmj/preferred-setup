const $ = (id) => document.getElementById(id);

const els = {
  summary: $("summary"),
  error: $("error"),
  save: $("save"),
  restore: $("restore"),
  auto: $("auto"),
  overlay: $("overlay"),
  advanced: $("advanced"),
  panel: $("advanced-panel"),
  groups: $("groups"),
  zoom: $("zoom"),
  layouts: $("layouts"),
  form: $("new-layout"),
  name: $("new-name"),
  exportBtn: $("export"),
  importInput: $("import"),
  monitors: $("monitors"),
};

let state = null;

function showError(text) {
  if (!text) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = text;
}

function formatWhen(stamp) {
  if (!stamp) return "not saved yet";
  const delta = Date.now() - stamp;
  if (delta < 60_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return new Date(stamp).toLocaleDateString();
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Something went wrong."));
        return;
      }
      resolve(response);
    });
  });
}

function render() {
  const settings = state?.settings;
  if (!settings) return;
  const active = settings.layouts.find((layout) => layout.id === settings.activeLayoutId) || null;
  const windowCount = active?.windows?.length || 0;
  const tabCount = (active?.windows || []).reduce((sum, win) => sum + win.tabs.length, 0);

  els.save.textContent = active ? "Update preferred setup" : "Save this arrangement";
  els.restore.disabled = !active;
  els.summary.textContent = active
    ? `${active.name} · ${windowCount} window${windowCount === 1 ? "" : "s"} · ${tabCount} tabs · ${formatWhen(active.savedAt)}`
    : `${state.openWindows} window${state.openWindows === 1 ? "" : "s"} open · nothing saved yet`;

  els.auto.checked = !!settings.autoRestore;
  els.overlay.checked = !!settings.showOverlay;
  els.advanced.checked = !!settings.showAdvanced;
  els.groups.checked = settings.preserveGroups !== false;
  els.zoom.checked = settings.preserveZoom !== false;
  els.panel.hidden = !settings.showAdvanced;

  els.layouts.replaceChildren();
  for (const layout of settings.layouts) {
    const item = document.createElement("li");
    item.className = "layout";

    const pick = document.createElement("input");
    pick.type = "radio";
    pick.name = "active-layout";
    pick.checked = layout.id === settings.activeLayoutId;
    pick.title = "Restore this one when Chrome starts";
    pick.addEventListener("change", () => {
      void run(() => send({ type: "set-active", id: layout.id }));
    });

    const label = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = layout.name;
    const meta = document.createElement("em");
    const tabs = layout.windows.reduce((sum, win) => sum + win.tabs.length, 0);
    meta.textContent = `${layout.windows.length} windows · ${tabs} tabs · ${formatWhen(layout.savedAt)}`;
    label.append(title, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      void run(() => send({ type: "delete-layout", id: layout.id }));
    });

    item.append(pick, label, remove);
    els.layouts.append(item);
  }

  const names = (state.displays || []).map((display) => display.name || "Monitor");
  els.monitors.textContent = names.length
    ? `${names.length} monitor${names.length === 1 ? "" : "s"} detected · ${names.join(" · ")}`
    : "Monitor list unavailable.";
}

async function run(work) {
  showError("");
  try {
    state = await work();
    render();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function refresh() {
  state = await send({ type: "get-state" });
  render();
}

els.save.addEventListener("click", () => {
  void run(() => send({ type: "save" }));
});

els.restore.addEventListener("click", () => {
  void run(() => send({ type: "restore" }));
});

function bindSwitch(element, key) {
  element.addEventListener("change", () => {
    void run(() => send({ type: "update-settings", patch: { [key]: element.checked } }));
  });
}

bindSwitch(els.auto, "autoRestore");
bindSwitch(els.overlay, "showOverlay");
bindSwitch(els.advanced, "showAdvanced");
bindSwitch(els.groups, "preserveGroups");
bindSwitch(els.zoom, "preserveZoom");

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.name.value.trim();
  if (!name) {
    showError("Name the layout.");
    return;
  }
  void run(async () => {
    const next = await send({ type: "save", name, asNew: true });
    els.name.value = "";
    return next;
  });
});

els.exportBtn.addEventListener("click", () => {
  void run(async () => {
    const result = await send({ type: "export" });
    const blob = new Blob([result.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "preferred-setup.json";
    link.click();
    URL.revokeObjectURL(url);
    return state;
  });
});

els.importInput.addEventListener("change", () => {
  const file = els.importInput.files?.[0];
  els.importInput.value = "";
  if (!file) return;
  void run(async () => {
    const json = await file.text();
    return send({ type: "import", json });
  });
});

void refresh().catch((error) => showError(error instanceof Error ? error.message : String(error)));
