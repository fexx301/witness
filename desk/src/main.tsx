// The Witness investigation desk: AG Studio with the dispute queue, the investigation page, and
// Witness plus AG's own agents in the chat.
import { AgStudioAiModule, AgStudioModuleRegistry, enableStudioDevValidations, studioTheme, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio } from "ag-studio-react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ai } from "./agents";
import { onRefresh, witnessSource } from "./data";

if (import.meta.env.DEV) enableStudioDevValidations();
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

// Light, for video and screen-share: ink text on near-white, with a cobalt accent.
const theme = studioTheme.withParams({
  backgroundColor: "#FBFBF8",
  foregroundColor: "#14213D",
  accentColor: "#2457D6",
  fontFamily: "Inter, Arial, sans-serif",
  borderRadius: 6,
});

const initialState: AgReportState = { pages: [{ id: "queue" }, { id: "investigation" }], selectedPageId: "queue" };

const data = { sources: [witnessSource] };
let studioApi: AgStudioApi | undefined;

function onApiReady(api: AgStudioApi) {
  studioApi = api;
  // A development handle, so a page built in the editor can be exported with getState().
  if (import.meta.env.DEV) (window as unknown as { witnessStudio?: AgStudioApi }).witnessStudio = api;
}

function Desk() {
  useEffect(() => onRefresh(() => studioApi?.reload()), []);
  return <AgStudio data={data} mode="edit" ai={ai} theme={theme} initialState={initialState} onApiReady={({ api }) => onApiReady(api)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Desk />
  </StrictMode>,
);
