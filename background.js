import {
  displayAtPoint,
  displayByOverlap,
  mapWindowBounds,
  monitorSnapshot,
  relativePlacement,
} from "./geometry.js";

const GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

const DEFAULTS = {
  version: 1,
  autoRestore: true,
  showOverlay: true,
  preserveGroups: true,
  preserveZoom: true,
  showAdvanced: false,
  activeLayoutId: null,
  layouts: [],
};

let restoreJob = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
  return settings;
}

function isSavableUrl(url) {
  if (!url) return false;
  if (url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("chrome-untrusted://")) return false;
  if (url.startsWith("devtools://")) return false;
  if (url.startsWith("about:")) return false;
  if (url.startsWith("chrome://") && !url.startsWith("chrome://newtab")) return false;
  if (url.startsWith("file:")) return false;
  return true;
}

function extensionWindow(win) {
  const tabs = win.tabs || [];
  return tabs.length > 0 && tabs.every((tab) => (tab.url || "").startsWith(chrome.runtime.getURL("")));
}

async function announce(text) {
  try {
    await chrome.runtime.sendMessage({ type: "deploy-progress", text });
  } catch {
    /* overlay not open */
  }
}

async function captureLayout(settings) {
  const displays = await chrome.system.display.getInfo();
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const savedWindows = [];

  for (const win of windows) {
    if (extensionWindow(win)) continue;
    const tabs = (win.tabs || []).filter((tab) => isSavableUrl(tab.url || tab.pendingUrl));
    if (!tabs.length) continue;

    const groupMeta = new Map();
    if (settings.preserveGroups) {
      try {
        const groups = await chrome.tabGroups.query({ windowId: win.id });
        for (const group of groups) {
          groupMeta.set(group.id, {
            key: `g${group.id}`,
            title: group.title || "",
            color: GROUP_COLORS.has(group.color) ? group.color : "grey",
            collapsed: !!group.collapsed,
          });
        }
      } catch {
        /* groups unavailable */
      }
    }

    const savedTabs = [];
    for (const tab of tabs) {
      let zoom = 1;
      if (settings.preserveZoom && tab.id != null) {
        try {
          zoom = await chrome.tabs.getZoom(tab.id);
        } catch {
          zoom = 1;
        }
      }
      const grouped =
        settings.preserveGroups && tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
          ? groupMeta.get(tab.groupId) || null
          : null;
      savedTabs.push({
        url: tab.url || tab.pendingUrl,
        title: tab.title || "",
        pinned: !!tab.pinned && !grouped,
        active: !!tab.active,
        zoom: Math.round((zoom || 1) * 100) / 100,
        group: tab.pinned ? null : grouped,
      });
    }
    if (!savedTabs.some((tab) => tab.active)) savedTabs[0].active = true;

    const width = win.width || 960;
    const height = win.height || 640;
    const rect = { left: win.left ?? 0, top: win.top ?? 0, width, height };
    const display =
      displayAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, displays) ||
      displayByOverlap(rect, displays);

    savedWindows.push({
      ...rect,
      state: win.state || "normal",
      focused: !!win.focused,
      monitor: display ? monitorSnapshot(display) : null,
      rel: display ? relativePlacement(rect, display) : null,
      tabs: savedTabs,
    });
  }

  return savedWindows;
}

async function openOverlay(displays) {
  const host =
    displays.find((display) => display.isPrimary) ||
    displays[0];
  const box = host?.workArea || host?.bounds || { left: 80, top: 80, width: 1280, height: 800 };
  const width = 560;
  const height = 300;
  return chrome.windows.create({
    url: chrome.runtime.getURL("deploy.html"),
    type: "popup",
    width,
    height,
    left: Math.round(box.left + (box.width - width) / 2),
    top: Math.round(box.top + Math.max(0, (box.height - height) / 2)),
    focused: true,
  });
}

async function applyTabs(created, savedWindow, settings) {
  const live = await chrome.tabs.query({ windowId: created.id });
  const count = Math.min(live.length, savedWindow.tabs.length);

  for (let index = 0; index < count; index += 1) {
    const spec = savedWindow.tabs[index];
    if (spec.pinned) {
      try {
        await chrome.tabs.update(live[index].id, { pinned: true });
      } catch {
        /* already pinned or not pinnable */
      }
    }
  }

  if (settings.preserveGroups) {
    let index = 0;
    while (index < count) {
      const group = savedWindow.tabs[index].group;
      if (!group || savedWindow.tabs[index].pinned) {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (
        end < count &&
        !savedWindow.tabs[end].pinned &&
        savedWindow.tabs[end].group &&
        savedWindow.tabs[end].group.key === group.key
      ) {
        end += 1;
      }
      const tabIds = live.slice(index, end).map((tab) => tab.id);
      try {
        const groupId = await chrome.tabs.group({
          tabIds,
          createProperties: { windowId: created.id },
        });
        await chrome.tabGroups.update(groupId, {
          title: group.title || "",
          color: GROUP_COLORS.has(group.color) ? group.color : "grey",
          collapsed: !!group.collapsed,
        });
      } catch {
        /* grouping can fail if a tab was pinned underneath */
      }
      index = end;
    }
  }

  if (settings.preserveZoom) {
    for (let index = 0; index < count; index += 1) {
      const zoom = savedWindow.tabs[index].zoom;
      if (!zoom || Math.abs(zoom - 1) < 0.02) continue;
      try {
        await chrome.tabs.setZoom(live[index].id, zoom);
      } catch {
        /* zoom is best-effort without site access */
      }
    }
  }

  const activeIndex = savedWindow.tabs.findIndex((tab) => tab.active);
  if (activeIndex >= 0 && activeIndex < count) {
    try {
      await chrome.tabs.update(live[activeIndex].id, { active: true });
    } catch {
      /* ignore */
    }
  }
}

async function restoreLayout(layout, settings) {
  if (restoreJob) return restoreJob;
  restoreJob = restoreLayoutNow(layout, settings).finally(() => {
    restoreJob = null;
  });
  return restoreJob;
}

async function restoreLayoutNow(layout, settings) {
  const windows = layout?.windows || [];
  if (!windows.length) throw new Error("That layout has no windows yet.");

  const displays = await chrome.system.display.getInfo();
  const before = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const beforeIds = new Set(before.map((win) => win.id));

  let overlayId = null;
  if (settings.showOverlay) {
    try {
      const overlay = await openOverlay(displays);
      overlayId = overlay?.id ?? null;
      await sleep(180);
    } catch {
      overlayId = null;
    }
  }

  await announce("Deploying your preferred setup");
  const createdIds = [];
  let focusedId = null;
  let fallbackCount = 0;

  for (let index = 0; index < windows.length; index += 1) {
    const saved = windows[index];
    const urls = (saved.tabs || []).map((tab) => tab.url).filter(isSavableUrl);
    if (!urls.length) continue;
    const matched = saved.monitor
      ? displays.some((display) => {
          const area =
            Math.max(
              0,
              Math.min(saved.monitor.left + saved.monitor.width, display.bounds.left + display.bounds.width) -
                Math.max(saved.monitor.left, display.bounds.left),
            ) *
            Math.max(
              0,
              Math.min(saved.monitor.top + saved.monitor.height, display.bounds.top + display.bounds.height) -
                Math.max(saved.monitor.top, display.bounds.top),
            );
          return area >= saved.monitor.width * saved.monitor.height * 0.25;
        })
      : true;
    const cascade = matched ? 0 : fallbackCount++;
    const bounds = mapWindowBounds(saved, displays, cascade);
    const label = saved.tabs.find((tab) => tab.active)?.title || saved.tabs[0]?.title || "window";
    await announce(`Placing ${label} · ${index + 1} of ${windows.length}`);

    try {
      const created = await chrome.windows.create({
        url: urls,
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        focused: false,
        state: "normal",
        type: "normal",
      });
      if (!created?.id) continue;
      createdIds.push(created.id);
      if (saved.focused) focusedId = created.id;
      await applyTabs(created, saved, settings);
      if (saved.state === "maximized" || saved.state === "fullscreen" || saved.state === "minimized") {
        try {
          await chrome.windows.update(created.id, { state: saved.state });
        } catch {
          /* state is best-effort */
        }
      }
    } catch (error) {
      await announce(error instanceof Error ? error.message : "Could not place a window");
    }
  }

  if (!createdIds.length) {
    await announce("Nothing could be restored. Your current windows were left as they are.");
    if (overlayId != null) {
      try {
        await chrome.windows.remove(overlayId);
      } catch {
        /* already gone */
      }
    }
    throw new Error("Could not open the saved windows.");
  }

  for (const id of beforeIds) {
    if (createdIds.includes(id)) continue;
    try {
      await chrome.windows.remove(id);
    } catch {
      /* already closed */
    }
  }

  const focus = focusedId || createdIds[createdIds.length - 1];
  try {
    await chrome.windows.update(focus, { focused: true });
  } catch {
    /* ignore */
  }

  await announce("Done");
  await sleep(280);
  if (overlayId != null) {
    try {
      await chrome.windows.remove(overlayId);
    } catch {
      /* already gone */
    }
  }
  try {
    await chrome.windows.update(focus, { focused: true });
  } catch {
    /* ignore */
  }
  return { placed: createdIds.length };
}

async function waitForStartupWindow() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (windows.length) return;
    await sleep(150);
  }
}

async function maybeAutoRestore() {
  const flag = await chrome.storage.session.get("didAutoRestore");
  if (flag.didAutoRestore) return;
  await chrome.storage.session.set({ didAutoRestore: true });

  const settings = await loadSettings();
  if (!settings.autoRestore) return;
  const layout = settings.layouts.find((item) => item.id === settings.activeLayoutId);
  if (!layout?.windows?.length) return;

  await waitForStartupWindow();
  await sleep(450);
  try {
    await restoreLayout(layout, settings);
  } catch {
    /* leave Chrome's own startup window in place */
  }
}

function normalizeLayout(raw, index) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.windows)) return null;
  const windows = raw.windows
    .filter((win) => win && Array.isArray(win.tabs))
    .map((win) => ({
      left: Number(win.left) || 0,
      top: Number(win.top) || 0,
      width: Number(win.width) || 960,
      height: Number(win.height) || 640,
      state: ["normal", "maximized", "minimized", "fullscreen"].includes(win.state) ? win.state : "normal",
      focused: !!win.focused,
      monitor:
        win.monitor && Number(win.monitor.width) > 0
          ? {
              left: Number(win.monitor.left) || 0,
              top: Number(win.monitor.top) || 0,
              width: Number(win.monitor.width) || 0,
              height: Number(win.monitor.height) || 0,
            }
          : null,
      rel:
        win.rel && Number(win.rel.w) > 0
          ? {
              x: Number(win.rel.x) || 0,
              y: Number(win.rel.y) || 0,
              w: Number(win.rel.w) || 0,
              h: Number(win.rel.h) || 0,
            }
          : null,
      tabs: win.tabs
        .filter((tab) => tab && isSavableUrl(tab.url))
        .map((tab) => ({
          url: String(tab.url),
          title: String(tab.title || ""),
          pinned: !!tab.pinned,
          active: !!tab.active,
          zoom: Number(tab.zoom) > 0 ? Number(tab.zoom) : 1,
          group:
            tab.group && typeof tab.group === "object"
              ? {
                  key: String(tab.group.key || tab.group.title || "group"),
                  title: String(tab.group.title || ""),
                  color: GROUP_COLORS.has(tab.group.color) ? tab.group.color : "grey",
                  collapsed: !!tab.group.collapsed,
                }
              : null,
        })),
    }))
    .filter((win) => win.tabs.length);
  if (!windows.length) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : `Layout ${index + 1}`,
    savedAt: Number(raw.savedAt) || Date.now(),
    windows,
  };
}

async function snapshot(name, asNew) {
  const settings = await loadSettings();
  const windows = await captureLayout(settings);
  if (!windows.length) throw new Error("No Chrome windows with pages to save. Open a few tabs first.");

  const now = Date.now();
  let layout = null;
  if (!asNew && settings.activeLayoutId) {
    layout = settings.layouts.find((item) => item.id === settings.activeLayoutId) || null;
  }
  if (layout && !asNew) {
    layout.windows = windows;
    layout.savedAt = now;
    if (name) layout.name = name.slice(0, 60);
  } else {
    layout = {
      id: crypto.randomUUID(),
      name: (name || "Preferred setup").slice(0, 60),
      savedAt: now,
      windows,
    };
    settings.layouts = [...settings.layouts, layout];
    settings.activeLayoutId = layout.id;
  }
  if (!settings.activeLayoutId) settings.activeLayoutId = layout.id;
  await saveSettings(settings);
  return layout;
}

async function publicState() {
  const settings = await loadSettings();
  let displays = [];
  try {
    const info = await chrome.system.display.getInfo();
    displays = info.map((display) => ({
      id: display.id,
      name: display.name || "Monitor",
      isPrimary: !!display.isPrimary,
      bounds: display.bounds,
    }));
  } catch {
    displays = [];
  }
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const real = windows.filter((win) => !extensionWindow(win));
  const tabCount = real.reduce(
    (sum, win) => sum + (win.tabs || []).filter((tab) => isSavableUrl(tab.url || tab.pendingUrl)).length,
    0,
  );
  return {
    settings,
    displays,
    openWindows: real.length,
    openTabs: tabCount,
  };
}

async function handle(message) {
  switch (message?.type) {
    case "get-state":
      return publicState();
    case "save": {
      const layout = await snapshot(message.name, !!message.asNew);
      return { ...(await publicState()), layout };
    }
    case "restore": {
      const settings = await loadSettings();
      const layout =
        settings.layouts.find((item) => item.id === (message.layoutId || settings.activeLayoutId)) || null;
      if (!layout) throw new Error("Save a setup first.");
      await restoreLayout(layout, settings);
      return publicState();
    }
    case "update-settings": {
      const settings = await loadSettings();
      const patch = message.patch || {};
      for (const key of ["autoRestore", "showOverlay", "preserveGroups", "preserveZoom", "showAdvanced"]) {
        if (typeof patch[key] === "boolean") settings[key] = patch[key];
      }
      await saveSettings(settings);
      return publicState();
    }
    case "set-active": {
      const settings = await loadSettings();
      if (!settings.layouts.some((item) => item.id === message.id)) throw new Error("Unknown layout.");
      settings.activeLayoutId = message.id;
      await saveSettings(settings);
      return publicState();
    }
    case "rename-layout": {
      const settings = await loadSettings();
      const layout = settings.layouts.find((item) => item.id === message.id);
      if (!layout) throw new Error("Unknown layout.");
      const name = String(message.name || "").trim();
      if (!name) throw new Error("Name the layout.");
      layout.name = name.slice(0, 60);
      await saveSettings(settings);
      return publicState();
    }
    case "delete-layout": {
      const settings = await loadSettings();
      settings.layouts = settings.layouts.filter((item) => item.id !== message.id);
      if (settings.activeLayoutId === message.id) {
        settings.activeLayoutId = settings.layouts[0]?.id || null;
      }
      await saveSettings(settings);
      return publicState();
    }
    case "export": {
      const settings = await loadSettings();
      return {
        json: JSON.stringify(
          {
            version: 1,
            kind: "preferred-setup",
            exportedAt: Date.now(),
            settings: {
              autoRestore: settings.autoRestore,
              showOverlay: settings.showOverlay,
              preserveGroups: settings.preserveGroups,
              preserveZoom: settings.preserveZoom,
              activeLayoutId: settings.activeLayoutId,
            },
            layouts: settings.layouts,
          },
          null,
          2,
        ),
      };
    }
    case "import": {
      const text = String(message.json || "");
      if (text.length > 2_000_000) throw new Error("That file is too large.");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const incoming = Array.isArray(parsed?.layouts) ? parsed.layouts : Array.isArray(parsed) ? parsed : [];
      const layouts = incoming.map(normalizeLayout).filter(Boolean);
      if (!layouts.length) throw new Error("No layouts found in that file.");
      const settings = await loadSettings();
      settings.layouts = layouts;
      const wanted = parsed?.settings?.activeLayoutId;
      settings.activeLayoutId = layouts.some((item) => item.id === wanted) ? wanted : layouts[0].id;
      if (parsed?.settings) {
        for (const key of ["autoRestore", "showOverlay", "preserveGroups", "preserveZoom"]) {
          if (typeof parsed.settings[key] === "boolean") settings[key] = parsed.settings[key];
        }
      }
      await saveSettings(settings);
      return publicState();
    }
    default:
      return { ignored: true };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type === "deploy-progress") return false;
  handle(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => {
  void maybeAutoRestore();
});
