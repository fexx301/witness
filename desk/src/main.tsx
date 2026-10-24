// The Witness investigation desk: AG Studio with the dispute queue, the investigation page, and
// Witness plus AG's own agents in the chat.
import { AgStudioAiModule, AgStudioModuleRegistry, enableStudioDevValidations, studioTheme, type AgStudioApi } from "ag-studio";
import { AgStudio } from "ag-studio-react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ai } from "./agents";
import { addCopyButtons } from "./copyReplies";
import { onRefresh, witnessSource } from "./data";
import { connectStudio, pageChanged, showPage, usePage, type PageId } from "./deskState";
import { initialState } from "./initialState";
import { widgets, type WitnessRegistry } from "./widgets";

if (import.meta.env.DEV) enableStudioDevValidations();
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

// Light, for video and screen-share: ink text on near-white, with a cobalt accent.
const theme = studioTheme.withParams({
  backgroundColor: "#FBFBF8",
  foregroundColor: "#14243A",
  accentColor: "#2457D6",
  fontFamily: "Inter, Arial, sans-serif",
  borderRadius: 6,
  // Built-in and Witness widgets share one title style.
  studioWidgetTitleFontFamily: "Inter, Arial, sans-serif",
  studioWidgetTitleFontSize: 14,
  studioWidgetTitleFontWeight: 700,
  studioWidgetTitleTextColor: "#14243A",
});


const data = { sources: [witnessSource] };
// AG Studio's canvas has a fixed grid and a 720 px minimum, so it can't reflow. On a narrower screen, decided
// once at load, the chat is hidden and the pages scroll sideways, with a note pointing to the video. "?chat" in the
// address keeps the chat anyway, for a laptop browser that isn't full width.
const narrow = window.matchMedia("(max-width: 899px)").matches && !new URLSearchParams(window.location.search).has("chat");
const videoUrl = import.meta.env.VITE_WITNESS_VIDEO_URL as string | undefined;
// Edit mode keeps the chat; the only panel shown is the AI assistant, so the desk reads as a dashboard.
const panels = { edit: { left: narrow ? [] : ["ai" as const], right: [] } };
let studioApi: AgStudioApi | undefined;

function onApiReady(api: AgStudioApi) {
  studioApi = api;
  connectStudio(api);
  // A development handle, so a page built in the editor can be exported with getState().
  if (import.meta.env.DEV) (window as unknown as { witnessStudio?: AgStudioApi }).witnessStudio = api;
}

const TABS: [PageId, string][] = [
  ["queue", "Dispute queue"],
  ["investigation", "Investigation"],
];

function Tabs() {
  const page = usePage();
  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 4, height: 44, padding: "0 12px", borderBottom: "1px solid #E3E6EB", background: "#FBFBF8", font: "14px Inter, Arial, sans-serif", color: "#14243A" }}>
      <img src="/witness-logo.svg" alt="Witness" height={30} style={{ marginRight: 16, flexShrink: 0 }} />
      {TABS.map(([id, label]) => (
        <button
          key={id}
          onClick={() => showPage(id)}
          aria-current={page === id ? "page" : undefined}
          style={{ padding: "6px 12px", border: "none", borderBottom: `2px solid ${page === id ? "#2457D6" : "transparent"}`, background: "none", color: page === id ? "#2457D6" : "#14243A", font: "600 14px Inter, Arial, sans-serif", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {label}
        </button>
      ))}
      <span style={{ marginLeft: "auto", paddingLeft: 12, minWidth: 0, color: "#5B6578", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Sandbox only. Witness investigates; a person decides what is sent to PayPal.</span>
    </nav>
  );
}

function NarrowNote() {
  return (
    <p style={{ margin: 0, padding: "8px 12px", background: "#EEF2FB", borderBottom: "1px solid #D6DEF2", font: "13px/1.4 Inter, Arial, sans-serif", color: "#14243A" }}>
      This desk is laid out for a laptop or desktop screen. Here the chat is hidden and the pages scroll sideways.{" "}
      <a href="?chat" style={{ color: "#2457D6", fontWeight: 600 }}>
        Show the chat anyway
      </a>
      .
      {videoUrl && (
        <>
          {" "}
          <a href={videoUrl} style={{ color: "#2457D6", fontWeight: 600 }}>
            Watch the 3-minute video
          </a>
          .
        </>
      )}
    </p>
  );
}

function Desk() {
  useEffect(() => onRefresh(() => studioApi?.reload()), []);
  useEffect(() => addCopyButtons(document.body), []);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Tabs />
      {narrow && <NarrowNote />}
      <div style={{ flex: 1, minHeight: 0, overflowX: narrow ? "auto" : undefined }}>
        <AgStudio<WitnessRegistry>
          style={{ height: "100%" }}
          data={data}
          mode="edit"
          panels={panels}
          widgets={widgets}
          ai={ai}
          theme={theme}
          initialState={initialState}
          onApiReady={({ api }) => onApiReady(api)}
          onStateUpdated={({ state }) => pageChanged(state.selectedPageId)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Desk />
  </StrictMode>,
);
