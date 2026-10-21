/*
 * workspace.js — owns the Blockly workspace: setup, the toolbox, and access to
 * the generated code. Block *definitions* are generated in blocks.js; this file
 * is the Blockly lifecycle and the editor glue around it.
 *
 * Blockly is injected lazily the first time the Blocks view is shown, because
 * injecting into a hidden (display:none) container measures everything as zero.
 * The toolbox is rebuilt whenever the component tree changes so a newly added
 * component immediately has blocks.
 */

import { devlog } from "./console.js";
import { allComponents } from "../components/_registry.js";
import { subscribe, walk, getScreen } from "./model.js";
import { registerComponentBlocks, blockTypesFor } from "./blocks.js";

let workspace = null;
let blocksRegistered = false;
let pendingXml = null; // blocks loaded before the workspace exists (lazy restore)

/**
 * Make sure the workspace exists and is sized to its container. Idempotent —
 * call it every time the Blocks view becomes visible.
 */
export function ensureWorkspace() {
  const Blockly = window.Blockly;
  if (!Blockly) { devlog.error("Blockly didn't load — check your connection on first run."); return null; }

  if (workspace) { Blockly.svgResize(workspace); return workspace; }

  if (!blocksRegistered) {
    try { registerComponentBlocks(Blockly); blocksRegistered = true; }
    catch (err) { devlog.error("Could not register component blocks:", err.message); return null; }
  }

  workspace = Blockly.inject("blockly-div", {
    toolbox: buildToolbox(),
    theme: blockworkTheme(Blockly),
    renderer: "zelos", // rounded, Scratch-like — friendly for students
    grid: { spacing: 24, length: 3, colour: "#243043", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.85, minScale: 0.4, maxScale: 2 },
    move: { scrollbars: true, drag: true, wheel: true },
    trashcan: true,
  });

  // Keep the toolbox in sync with the project's components.
  subscribe((reason) => { if (reason === "tree" && workspace) workspace.updateToolbox(buildToolbox()); });

  // Restore any blocks that were loaded before the workspace existed.
  if (pendingXml) { applyXml(pendingXml); pendingXml = null; }

  devlog.info("Blocks workspace ready.");
  return workspace;
}

export const getWorkspace = () => workspace;

/** The generated JavaScript for the current blocks (the body of the app program). */
export function getGeneratedCode() {
  if (workspace) return window.Blockly.JavaScript.workspaceToCode(workspace);
  // Blocks view not opened yet (e.g. an example opened, then Preview/Export):
  // generate from the stashed XML in a headless workspace.
  if (!pendingXml || !window.Blockly) return "";
  const Blockly = window.Blockly;
  if (!blocksRegistered) {
    try { registerComponentBlocks(Blockly); blocksRegistered = true; }
    catch (err) { devlog.error("Could not register component blocks:", err.message); return ""; }
  }
  const headless = new Blockly.Workspace();
  try {
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(pendingXml), headless);
    return Blockly.JavaScript.workspaceToCode(headless);
  } catch (err) {
    devlog.error("Could not generate code from blocks:", err.message);
    return "";
  } finally {
    headless.dispose();
  }
}

/** Serialise / restore blocks as XML (used by project save/load — Milestone 7). */
export function getBlocksXml() {
  if (!workspace) return pendingXml ?? "";   // not drawn yet: keep the loaded blocks
  const Blockly = window.Blockly;
  return Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
}
export function loadBlocksXml(xml) {
  if (!xml) return;
  // Lazy: if the workspace isn't created yet (e.g. on startup restore), stash
  // the XML and load it when ensureWorkspace() runs. Avoids forcing Blockly to
  // initialise into a hidden container before the user opens the Blocks view.
  if (!workspace) { pendingXml = xml; return; }
  applyXml(xml);
}

function applyXml(xml) {
  const Blockly = window.Blockly;
  if (!Blockly) return;
  workspace.clear();
  try {
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml), workspace);
  } catch (err) {
    devlog.error("Could not load blocks:", err.message);
  }
}

/** Empty the blocks workspace (used by New project). */
export function clearBlocks() {
  pendingXml = null;
  if (workspace) workspace.clear();
}

/**
 * Update existing blocks after a component is renamed: every INSTANCE dropdown
 * pointing at the old name is repointed to the new one. Call AFTER the model has
 * the new name.
 *
 * We round-trip the blocks through XML rather than calling field.setValue: the
 * instance dropdowns are *dynamic* and cache their options when the block is
 * created, so setValue to a freshly-created name gets rejected as "not an
 * option". Reloading from XML rebuilds the dropdowns with current options.
 */
export function renameInstance(oldName, newName) {
  if (!workspace || oldName === newName) return;
  const Blockly = window.Blockly;
  const dom = Blockly.Xml.workspaceToDom(workspace);
  let changed = false;
  for (const field of dom.querySelectorAll('field[name="INSTANCE"]')) {
    if (field.textContent === oldName) { field.textContent = newName; changed = true; }
  }
  if (!changed) return;
  workspace.clear();
  Blockly.Xml.domToWorkspace(dom, workspace);
}

/* ------------------------------------------------------------------ */
/* Toolbox                                                            */
/* ------------------------------------------------------------------ */

/** Standard Blockly categories plus one category per component in the project. */
function buildToolbox() {
  return { kind: "categoryToolbox", contents: [...standardCategories(), { kind: "sep" }, ...componentCategories()] };
}

function block(type) { return { kind: "block", type }; }

function standardCategories() {
  return [
    { kind: "category", name: "Logic", colour: "210", contents: [
      "controls_if", "logic_compare", "logic_operation", "logic_negate",
      "logic_boolean", "logic_null", "logic_ternary",
    ].map(block) },
    { kind: "category", name: "Loops", colour: "120", contents: [
      "controls_repeat_ext", "controls_whileUntil", "controls_for",
      "controls_forEach", "controls_flow_statements",
    ].map(block) },
    { kind: "category", name: "Math", colour: "230", contents: [
      "math_number", "math_arithmetic", "math_single", "math_round",
      "math_modulo", "math_random_int", "math_constrain",
    ].map(block) },
    { kind: "category", name: "Text", colour: "160", contents: [
      "text", "text_join", "text_length", "text_isEmpty", "text_indexOf",
      "text_charAt", "text_getSubstring", "text_changeCase", "text_print",
    ].map(block) },
    { kind: "category", name: "Lists", colour: "260", contents: [
      "lists_create_with", "lists_repeat", "lists_length", "lists_isEmpty",
      "lists_indexOf", "lists_getIndex", "lists_setIndex",
    ].map(block) },
    { kind: "category", name: "Variables", colour: "330", custom: "VARIABLE" },
    { kind: "category", name: "Functions", colour: "290", custom: "PROCEDURE" },
  ];
}

/** A category per component type present in the project (Screen always shown). */
function componentCategories() {
  const present = new Set(["Screen"]);
  walk((node) => present.add(node.type));

  const cats = [];
  for (const def of allComponents()) {
    if (!present.has(def.name)) continue;
    const blocks = blockTypesFor(def).map(block);
    if (blocks.length) {
      cats.push({ kind: "category", name: `${def.icon} ${def.name}`, colour: catColour(def.category), contents: blocks });
    }
  }
  return cats;
}

function catColour(category) {
  return { UI: "230", Layout: "200", Storage: "160", Media: "20", Sensors: "30", IoT: "180", Dashboard: "300" }[category] ?? "120";
}

function blockworkTheme(Blockly) {
  return Blockly.Theme.defineTheme("blockworkDark", {
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: "#0f172a",
      toolboxBackgroundColour: "#1e293b",
      toolboxForegroundColour: "#f1f5f9",
      flyoutBackgroundColour: "#162033",
      flyoutForegroundColour: "#cbd5e1",
      flyoutOpacity: 1,
      scrollbarColour: "#334155",
      insertionMarkerColour: "#6366f1",
      insertionMarkerOpacity: 0.4,
      cursorColour: "#6366f1",
    },
  });
}
