import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(rootDir, 'dist', 'client.cjs');

const CLIENT_BUNDLE = `window.__ModuleLoader__.load({
  id: "@smitfire/board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsx = require("react/jsx-runtime").jsx;
    const jsxs = require("react/jsx-runtime").jsxs;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "nsBoard";
    const COLUMNS = [
      { id: "backlog", title: "Backlog" },
      { id: "ready", title: "Ready" },
      { id: "in_progress", title: "In Progress" },
      { id: "review", title: "Review" },
      { id: "done", title: "Done" },
      { id: "blocked", title: "Blocked" }
    ];

    const en = { panel: "Kanban Board", empty: "No active cards yet.", open: "Open Board" };
    const zh = { panel: "任务看板", empty: "暂无任务卡片。", open: "打开看板" };

    function useBoardSnapshot() {
      const stateTuple = react.useState(null);
      const snap = stateTuple[0];
      const setSnap = stateTuple[1];
      const errTuple = react.useState(null);
      const err = errTuple[0];
      const setErr = errTuple[1];

      react.useEffect(() => {
        let active = true;
        fetch("/ns-board/api/state")
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((data) => { if (active) { setSnap(data); setErr(null); } })
          .catch((e) => { if (active) setErr(e && e.message ? e.message : String(e)); });

        if (typeof EventSource !== "undefined") {
          const es = new EventSource("/ns-board/api/events");
          es.addEventListener("board", (ev) => {
            try {
              const parsed = JSON.parse(ev.data);
              if (active) setSnap(parsed);
            } catch (e) {
              console.error("invalid board SSE payload", e);
            }
          });
          return () => {
            active = false;
            es.close();
          };
        }
        return () => { active = false; };
      }, []);

      return { snap, err, setErr, refresh: () => {
        fetch("/ns-board/api/state")
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((data) => { setSnap(data); setErr(null); })
          .catch((e) => setErr(e && e.message ? e.message : String(e)));
      } };
    }

    async function postMove(payload, state) {
      try {
        const res = await fetch("/ns-board/api/move", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const outcome = await res.json();
        if (!res.ok || !outcome.ok) {
          throw new Error(outcome.reason || outcome.error || ("HTTP " + res.status));
        }
        if (state.refresh) state.refresh();
      } catch (e) {
        if (state.setErr) state.setErr(e && e.message ? e.message : String(e));
      }
    }

    function KanbanSidebarIcon(props) {
      const Icon = primitives && primitives.IconChecklistOutlineRegular;
      if (Icon) return jsx(Icon, { size: props.size || 16 });
      return jsx("span", { style: { fontSize: "12px", fontWeight: 600 }, children: "KB" });
    }

    function KanbanDockStrip(props) {
      const state = useBoardSnapshot();
      const snap = state.snap;
      if (!snap || !snap.cards || snap.cards.length === 0) return null;
      const counts = snap.counts || {};
      const attention = snap.cards.filter((c) => c.approvalNeeded || c.column === "blocked" || c.column === "review").length;
      return jsxs("div", {
        "data-ns-board-dock": true,
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          padding: "4px 10px",
          fontSize: "12px",
          borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))"
        },
        children: [
          jsx("span", {
            children: "Kanban rev " + snap.revision + " · ready:" + (counts.ready || 0) + " active:" + (counts.in_progress || 0) + " review:" + (counts.review || 0) + " done:" + (counts.done || 0) + (attention ? " · " + attention + " attention" : "")
          }),
          jsx("button", {
            type: "button",
            onClick: () => { if (props.openBoard) props.openBoard(); },
            style: { fontSize: "12px", cursor: "pointer", padding: "2px 8px", borderRadius: "6px" },
            children: "Open Kanban"
          })
        ]
      });
    }

    function KanbanBoardPage() {
      const state = useBoardSnapshot();
      const snap = state.snap;
      if (state.err) return jsx("div", { style: { padding: "24px" }, children: "Board error: " + state.err });
      if (!snap) return jsx("div", { style: { padding: "24px" }, children: "Loading Kanban board..." });
      const cards = snap.cards || [];
      return jsxs("div", {
        "data-ns-board-page": true,
        style: { padding: "16px", height: "100%", overflow: "auto" },
        children: [
          jsxs("div", {
            style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" },
            children: [
              jsx("h2", { style: { margin: 0, fontSize: "16px" }, children: "ns-dsh HITL Kanban & DAG Board (rev " + snap.revision + ")" }),
              jsx("span", { style: { fontSize: "12px", opacity: 0.75 }, children: cards.length + " cards" })
            ]
          }),
          jsx("div", {
            style: { display: "grid", gridTemplateColumns: "repeat(6, minmax(190px, 1fr))", gap: "10px", alignItems: "start" },
            children: COLUMNS.map((col) => {
              const colCards = cards.filter((c) => c.column === col.id);
              return jsxs("section", {
                "data-board-col": col.id,
                style: {
                  border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))",
                  borderRadius: "8px",
                  padding: "8px"
                },
                children: [
                  jsx("h3", { style: { margin: "0 0 8px", fontSize: "12px", textTransform: "uppercase" }, children: col.title + " (" + colCards.length + ")" }),
                  colCards.length === 0 ? jsx("p", { style: { fontSize: "11px", opacity: 0.6 }, children: "-" }) : null,
                  colCards.map((c) => jsxs("article", {
                    "data-card-id": c.id,
                    style: {
                      border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))",
                      borderRadius: "6px",
                      padding: "8px",
                      marginBottom: "8px",
                      fontSize: "12px"
                    },
                    children: [
                      jsx("div", { style: { fontWeight: 600 }, children: c.title }),
                      jsx("div", { style: { fontSize: "11px", opacity: 0.75, marginTop: "2px" }, children: c.id + " · r" + c.revision + " · " + c.owner }),
                      c.writeScopes && c.writeScopes.length > 0 ? jsx("div", { style: { fontSize: "11px", marginTop: "4px" }, children: "scopes: " + c.writeScopes.join(", ") }) : null,
                      c.blockedBy && c.blockedBy.length > 0 ? jsx("div", { style: { fontSize: "11px", marginTop: "2px" }, children: "blockedBy: " + c.blockedBy.join(", ") }) : null,
                      c.approvalNeeded ? jsx("div", { style: { fontSize: "11px", color: "#d97706", marginTop: "4px" }, children: "Approval: " + c.approvalNeeded.toolName + " — " + c.approvalNeeded.reason }) : null,
                      jsxs("div", {
                        style: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" },
                        children: [
                          c.approvalNeeded ? jsx("button", {
                            type: "button",
                            onClick: () => postMove({ cardId: c.id, toColumn: "in_progress", actor: "human", role: "human", clearApproval: true, expectedRevision: c.revision, reason: "Authorized in WebUI" }, state),
                            children: "Authorize"
                          }) : null,
                          col.id === "review" ? jsx("button", {
                            type: "button",
                            onClick: () => postMove({ cardId: c.id, toColumn: "done", actor: "human", role: "human", expectedRevision: c.revision, reason: "Approved in WebUI" }, state),
                            children: "Approve"
                          }) : null,
                          col.id !== "ready" && col.id !== "done" ? jsx("button", {
                            type: "button",
                            onClick: () => postMove({ cardId: c.id, toColumn: "ready", actor: "human", role: "human", clearApproval: true, expectedRevision: c.revision, reason: "Requeued in WebUI" }, state),
                            children: "Requeue"
                          }) : null,
                          col.id !== "blocked" && col.id !== "done" ? jsx("button", {
                            type: "button",
                            onClick: () => postMove({ cardId: c.id, toColumn: "blocked", actor: "human", role: "human", expectedRevision: c.revision, reason: "Blocked in WebUI" }, state),
                            children: "Block"
                          }) : null
                        ]
                      })
                    ]
                  }, c.id))
                ]
              }, col.id);
            })
          })
        ]
      });
    }

    const inject = ["slots", "locale", "layout"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ns-board: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "ns-board", locale: NS }, KanbanBoardPage));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "ns-board", order: 15, label: () => t("panel"), locale: NS }, KanbanSidebarIcon));
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "ns-board-dock", order: 25, locale: NS, inject: () => ({ openBoard: () => ctx.layout.selectPanel("ns-board") }) }, KanbanDockStrip));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, CLIENT_BUNDLE, 'utf8');
