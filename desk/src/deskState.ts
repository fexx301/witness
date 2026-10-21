// The desk's own state beside AG Studio's: which page is showing, which dispute is open, and that
// dispute's investigation. Investigating and executing ask for a refresh, which reloads the queue
// and the open investigation.
import type { AgStudioApi } from "ag-studio";
import { useEffect, useState, useSyncExternalStore } from "react";
import { onRefresh, requestRefresh } from "./data";

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
      listeners.forEach((listener) => listener());
    },
    use: () =>
      useSyncExternalStore(
        (listener) => (listeners.add(listener), () => listeners.delete(listener)),
        () => value,
      ),
  };
}

export type PageId = "queue" | "investigation";
let studio: AgStudioApi | undefined;
const page = store<PageId>("queue");
const selected = store<string | null>(null);

export const usePage = page.use;
export const useSelectedDispute = selected.use;

export function connectStudio(api: AgStudioApi) {
  studio = api;
}
// Studio reports page changes made in its own UI too.
export const pageChanged = (id: string) => page.set(id === "investigation" ? "investigation" : "queue");

export function showPage(id: PageId) {
  if (!studio) return;
  const state = studio.getState();
  if (state.selectedPageId !== id) studio.setState({ ...state, selectedPageId: id });
  page.set(id);
}

export const selectDispute = (disputeId: string) => selected.set(disputeId);

export function openDispute(disputeId: string) {
  selectDispute(disputeId);
  showPage("investigation");
}

export interface Finding {
  key: string;
  status: string;
  summary: string;
  sources: string[];
  uncited?: string[];
}
export interface Step {
  kind: string;
  notes?: string;
  note?: string;
  message?: string;
  reason?: string;
  acceptClaimType?: string;
  offerType?: string;
  evidenceType?: string;
  trackingInfo?: { carrier_name: string; carrier_name_other?: string; tracking_number: string }[];
}
export interface Decision {
  action: string;
  basis: string;
  why: string[];
  gaps: string[];
  discrepancy?: string;
}
export interface InvestigationView {
  reviewed: {
    disputeId: string;
    ranAt: string;
    model: string;
    policy: string;
    claim: { reason: string; stage: string; status: string; outcome?: string; amount: { currency: string; value: number }; buyerStatements: string[]; mandateHash?: string };
    checks: { rule: string; status: string; detail: string }[];
    findings: Finding[];
    assessment: { claim_type: string; claim_summary: string };
    decision: Decision;
    writing: { dropped: { text: string; sources: string[] }[] };
    steps: Step[];
  };
  mandate: { agent: string; scope: { max_amount_usd: string; merchants: string[]; category: string }; instructions?: string[]; valid_until: string } | null;
  baseline: { ranAt: string; decision: Decision; findings: Finding[] } | null;
  executed: { ranAt: string; steps: Step[]; results: { step: string; ok: boolean; debugId?: string | null; error?: string }[] } | null;
  lastSent: { ranAt: string; stage?: string; results: { step: string; ok: boolean; debugId?: string | null }[] } | null;
}

export type Loaded = { state: "none" } | { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; view: InvestigationView };

export function useInvestigation(disputeId: string | null): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: disputeId ? "loading" : "none" });
  useEffect(() => {
    if (!disputeId) return setLoaded({ state: "none" });
    let current = true;
    const load = () =>
      fetch(`/api/investigation?id=${encodeURIComponent(disputeId)}`)
        .then(async (response) => {
          const body = await response.json();
          if (!current) return;
          if (response.status === 404) setLoaded({ state: "missing" });
          else if (!response.ok) setLoaded({ state: "error", message: body.error ?? `Witness server returned ${response.status}` });
          else setLoaded({ state: "ready", view: body as InvestigationView });
        })
        .catch((error: Error) => current && setLoaded({ state: "error", message: error.message }));
    setLoaded({ state: "loading" });
    load();
    const stop = onRefresh(load);
    return () => {
      current = false;
      stop();
    };
  }, [disputeId]);
  return loaded;
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Witness server returned ${response.status}`);
  return result;
}

export async function investigate(disputeId: string) {
  const result = await post("/api/investigate", { disputeId });
  requestRefresh();
  return result as { ranAt: string };
}

// Sends exactly the reviewed investigation identified by its time; the server makes no new assessment.
export async function execute(disputeId: string, ranAt: string) {
  const result = await post("/api/execute", { disputeId, ranAt });
  requestRefresh();
  return result as { results: { step: string; ok: boolean; debugId?: string | null; error?: string }[] };
}
