// Lightweight Automation Studio — WhatsApp × Shopify
// Self-contained, Tailwind-only (no shadcn, no framer-motion)
import React, { useMemo, useRef, useState } from "react";
import {
  Rocket,
  Plus,
  Play,
  Save,
  CirclePlay,
  ShoppingCart,
  MessageSquare,
  Timer,
  GitBranch,
  Webhook,
  SplitSquareHorizontal,
  CheckCircle2,
  Ban,
  ScanLine,
  Settings2,
  Trash,
} from "lucide-react";

const NODE_TYPES = {
  TRIGGER: "trigger",
  CONDITION: "condition",
  ACTION: "action",
  DELAY: "delay",
  EXIT: "exit",
};

const PORT = { IN: "in", OUT: "out" };

const TRIGGERS = [
  {
    id: "t_shopify_paid",
    label: "Shopify: Order Paid",
    icon: <ShoppingCart className="w-4 h-4" />,
    payloadHint:
      '{"topic":"orders/paid","order_number":"#1024","total_price":499,"customer":{"phone":"+212612345678","first_name":"Nora"}}',
    config: { source: "shopify", topic: "orders/paid" },
  },
  {
    id: "t_shopify_fulfilled",
    label: "Shopify: Fulfillment Out for Delivery",
    icon: <ScanLine className="w-4 h-4" />,
    payloadHint:
      '{"topic":"fulfillments/create","tracking":"OSC123","customer":{"phone":"+212612345678"}}',
    config: { source: "shopify", topic: "fulfillments/create" },
  },
  {
    id: "t_whatsapp_in",
    label: "WhatsApp: Incoming Message",
    icon: <MessageSquare className="w-4 h-4" />,
    payloadHint: '{"text":"size 38 for girl" ,"from":"+212612345678"}',
    config: { source: "whatsapp", topic: "message" },
  },
];

const ACTIONS = [
  {
    id: "a_send_template",
    label: "WhatsApp: Send Template",
    icon: <MessageSquare className="w-4 h-4" />,
    config: {
      type: "send_whatsapp_template",
      to: "{{ phone }}",
      template_name: "order_confirmed",
      language: "en",
      components: [
        { type: "body", parameters: [{ type: "text", text: "{{ order_number }}" }] },
      ],
    },
  },
  {
    id: "a_send_text",
    label: "WhatsApp: Send Text",
    icon: <MessageSquare className="w-4 h-4" />,
    config: {
      type: "send_whatsapp_text",
      to: "{{ phone }}",
      text: "مرحبا! طلبك قيد المعالجة.",
    },
  },
  {
    id: "a_stop",
    label: "Stop / Exit",
    icon: <Ban className="w-4 h-4" />,
    config: { type: "exit" },
  },
];

const LOGIC = [
  {
    id: "c_condition",
    label: "Condition",
    icon: <SplitSquareHorizontal className="w-4 h-4" />,
    config: {
      expression: "{{ topic }} == 'orders/paid' && {{ total_price }} >= 300",
      trueLabel: "Yes",
      falseLabel: "No",
    },
  },
  {
    id: "d_delay",
    label: "Delay",
    icon: <Timer className="w-4 h-4" />,
    config: { minutes: 10 },
  },
];

// Shopify event catalog with common variables and sample payload hints
const SHOPIFY_EVENTS = [
  {
    id: "orders/create",
    label: "Shopify: New Order",
    topic: "orders/create",
    variables: [
      "id",
      "order_number",
      "financial_status",
      "total_price",
      "created_at",
      "customer.id",
      "customer.first_name",
      "customer.last_name",
      "customer.phone",
      "line_items[].title",
      "line_items[].variant_title",
      "shipping_address.city",
      "shipping_address.province",
    ],
    sample: JSON.stringify({
      topic: "orders/create",
      id: 123456,
      order_number: "#1025",
      financial_status: "paid",
      total_price: 499,
      created_at: "2024-01-01T12:00:00Z",
      customer: { id: 999, first_name: "Nora", last_name: "A.", phone: "+212612345678" },
      line_items: [{ title: "T-Shirt", variant_title: "Large" }],
      shipping_address: { city: "Casablanca", province: "Casablanca-Settat" },
    }, null, 2),
  },
  {
    id: "orders/paid",
    label: "Shopify: Order Paid",
    topic: "orders/paid",
    variables: ["id", "order_number", "total_price", "customer.phone", "created_at"],
    sample: JSON.stringify({
      topic: "orders/paid",
      id: 123456,
      order_number: "#1025",
      total_price: 499,
      created_at: "2024-01-01T12:00:00Z",
      customer: { phone: "+212612345678" },
    }, null, 2),
  },
  {
    id: "customers/create",
    label: "Shopify: New Customer",
    topic: "customers/create",
    variables: [
      "id",
      "email",
      "first_name",
      "last_name",
      "phone",
      "default_address.city",
      "default_address.province",
    ],
    sample: JSON.stringify({
      topic: "customers/create",
      id: 1001,
      email: "nora@example.com",
      first_name: "Nora",
      last_name: "A.",
      phone: "+212612345678",
      default_address: { city: "Rabat", province: "Rabat-Salé-Kénitra" },
    }, null, 2),
  },
  {
    id: "checkouts/update",
    label: "Shopify: Abandoned Checkout",
    topic: "checkouts/update",
    variables: [
      "id",
      "abandoned_checkout_url",
      "email",
      "phone",
      "line_items[].title",
      "line_items[].variant_title",
      "total_price",
      "created_at",
    ],
    sample: JSON.stringify({
      topic: "checkouts/update",
      id: 222,
      abandoned_checkout_url: "https://shop.myshopify.com/123/abandon",
      email: "nora@example.com",
      phone: "+212612345678",
      line_items: [{ title: "Shoes", variant_title: "42" }],
      total_price: 299,
      created_at: "2024-01-01T12:10:00Z",
    }, null, 2),
  },
];

function TagIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82Z" />
      <path d="M7 7h.01" />
    </svg>
  );
}

let idSeq = 1;
const nextId = () => "n" + idSeq++;

const defaultFlow = () => {
  const trigger = makeNode(NODE_TYPES.TRIGGER, 120, 160, {
    name: "Order Paid",
    ...TRIGGERS[0].config,
    sample: TRIGGERS[0].payloadHint,
  });
  const cond = makeNode(NODE_TYPES.CONDITION, 420, 160, {
    expression: "{{ total_price }} >= 300",
    trueLabel: "VIP",
    falseLabel: "Regular",
  });
  const act1 = makeNode(NODE_TYPES.ACTION, 720, 80, {
    label: "Send Confirm (EN)",
    ...ACTIONS[0].config,
  });
  const delay = makeNode(NODE_TYPES.DELAY, 720, 240, { minutes: 5 });
  const act2 = makeNode(NODE_TYPES.ACTION, 960, 240, {
    label: "Nurture Text (AR)",
    ...ACTIONS[1].config,
    text: "مبروك 🎉 الطلب ديالك تأكد. شكراً على الثقة!",
  });

  const edges = [
    makeEdge(trigger.id, PORT.OUT, cond.id, PORT.IN),
    makeEdge(cond.id, "true", act1.id, PORT.IN),
    makeEdge(cond.id, "false", delay.id, PORT.IN),
    makeEdge(delay.id, PORT.OUT, act2.id, PORT.IN),
  ];

  return { nodes: [trigger, cond, act1, delay, act2], edges };
};

function makeNode(type, x, y, data = {}) {
  return { id: nextId(), type, x, y, data, selected: false };
}

function makeEdge(from, fromPort, to, toPort) {
  return { id: nextId(), from, fromPort, to, toPort };
}

export default function AutomationStudio({ onClose, initialFlow = null, onSaveFlow = null }) {
  const [flow, setFlow] = useState(initialFlow && initialFlow.nodes && initialFlow.edges ? initialFlow : defaultFlow);
  const [linking, setLinking] = useState(null);
  const [selected, setSelected] = useState(null);
  const [zoom, setZoom] = useState(1);

  const dragRef = useRef({ id: null, offsetX: 0, offsetY: 0 });
  const canvasRef = useRef(null);

  const onCanvasDown = (e) => {
    if (e.target.dataset && e.target.dataset.canvas) {
      setSelected(null);
    }
  };

  const onNodeMouseDown = (e, node) => {
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id: node.id,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    setSelected(node.id);
  };

  const onMouseMove = (e) => {
    const d = dragRef.current;
    if (!d.id) return;
    const rect = canvasRef.current ? canvasRef.current.getBoundingClientRect() : null;
    if (!rect) return;
    setFlow((f) => ({
      ...f,
      nodes: f.nodes.map((n) =>
        n.id === d.id
          ? {
              ...n,
              x: (e.clientX - rect.left - d.offsetX) / zoom,
              y: (e.clientY - rect.top - d.offsetY) / zoom,
            }
          : n
      ),
    }));
  };

  const onMouseUp = () => {
    dragRef.current = { id: null };
  };

  const startLink = (nodeId, port) => setLinking({ from: nodeId, fromPort: port });
  const completeLink = (toId, toPort) => {
    if (!linking) return;
    if (linking.from === toId) return setLinking(null);
    setFlow((f) => ({
      ...f,
      edges: [...f.edges, makeEdge(linking.from, linking.fromPort, toId, toPort)],
    }));
    setLinking(null);
  };

  const deleteNode = (id) =>
    setFlow((f) => ({
      nodes: f.nodes.filter((n) => n.id !== id),
      edges: f.edges.filter((e) => e.from !== id && e.to !== id),
    }));

  const deleteEdge = (id) =>
    setFlow((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== id) }));

  const addNode = (preset) => {
    let type = NODE_TYPES.ACTION;
    if (TRIGGERS.find((t) => t.id === preset.id)) type = NODE_TYPES.TRIGGER;
    if (LOGIC.find((l) => l.id === preset.id || preset.id?.startsWith("c_")))
      type = NODE_TYPES.CONDITION;
    if (preset.id?.startsWith("d_")) type = NODE_TYPES.DELAY;

    const x = 240 + Math.random() * 400;
    const y = 140 + Math.random() * 260;
    const data = { ...preset.config };
    if (preset.payloadHint) data.sample = preset.payloadHint;
    setFlow((f) => ({ ...f, nodes: [...f.nodes, makeNode(type, x, y, data)] }));
  };

  const selectedNode = flow.nodes.find((n) => n.id === selected) || null;

  const onUpdateSelected = (patch) => {
    if (!selectedNode) return;
    setFlow((f) => ({
      ...f,
      nodes: f.nodes.map((n) =>
        n.id === selectedNode.id ? { ...n, data: { ...n.data, ...patch } } : n
      ),
    }));
  };

  const [running, setRunning] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState(null);
  const handleSave = async () => {
    try {
      if (typeof onSaveFlow === 'function') await onSaveFlow(flow);
    } catch {}
  };

  const simulate = async () => {
    setRunning(true);
    const triggers = flow.nodes.filter((n) => n.type === NODE_TYPES.TRIGGER);
    if (!triggers.length) {
      setRunning(false);
      return;
    }
    for (const start of triggers) {
      // eslint-disable-next-line no-await-in-loop
      await visit(start.id);
    }
    setRunning(false);
  };

  const visit = async (nodeId) => {
    setActiveNodeId(nodeId);
    await wait(600);
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const outs = flow.edges.filter((e) => e.from === nodeId);
    if (node.type === NODE_TYPES.CONDITION) {
      const yes = outs.find((e) => e.fromPort === "true");
      const no = outs.find((e) => e.fromPort === "false");
      const next = Math.random() > 0.5 ? yes : no;
      if (next) await visit(next.to);
      return;
    }
    for (const edge of outs) {
      // eslint-disable-next-line no-await-in-loop
      await visit(edge.to);
    }
  };

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  return (
    <div className="h-screen w-full bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-sky-50 via-white to-indigo-50 text-slate-800">
      <header className="h-12 px-3 flex items-center justify-between border-b bg-white/70 backdrop-blur sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <Rocket className="w-5 h-5 text-blue-600" />
          <h1 className="font-semibold text-base">Automation Studio — WhatsApp × Shopify</h1>
          <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">Beta</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 border rounded text-sm"
            onClick={simulate}
            disabled={running}
          >
            <span className="inline-flex items-center gap-1"><Play className="w-4 h-4" />Test run</span>
          </button>
          <button
            className="px-2 py-1 border rounded text-sm"
            onClick={() => alert("Saved draft (wire up API)!")}
          >
            <span className="inline-flex items-center gap-1"><Save className="w-4 h-4" />Save draft</span>
          </button>
          <button
            className="px-2 py-1 rounded text-sm bg-blue-600 text-white"
            onClick={() => alert("Published (replace with API)")}
          >
            <span className="inline-flex items-center gap-1"><CirclePlay className="w-4 h-4" />Publish</span>
          </button>
          {onClose && (
            <button className="ml-2 px-2 py-1 border rounded text-sm" onClick={onClose}>Close</button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-12 gap-3 p-3 h-[calc(100vh-3rem)]">
        <aside className="col-span-12 md:col-span-3 space-y-3 overflow-y-auto pb-20">
          <div className="border rounded">
            <div className="px-3 py-2 border-b text-sm font-medium flex items-center gap-2"><Webhook className="w-4 h-4"/>Triggers</div>
            <div className="p-2 grid gap-2">
              {TRIGGERS.map((t) => (
                <PaletteItem key={t.id} icon={t.icon} label={t.label} onAdd={() => addNode(t)} />
              ))}
            </div>
          </div>
          <div className="border rounded">
            <div className="px-3 py-2 border-b text-sm font-medium flex items-center gap-2"><GitBranch className="w-4 h-4"/>Logic</div>
            <div className="p-2 grid gap-2">
              {LOGIC.map((l) => (
                <PaletteItem key={l.id} icon={l.icon} label={l.label} onAdd={() => addNode(l)} />
              ))}
            </div>
          </div>
          <div className="border rounded">
            <div className="px-3 py-2 border-b text-sm font-medium flex items-center gap-2"><Settings2 className="w-4 h-4"/>Actions</div>
            <div className="p-2 grid gap-2">
              {ACTIONS.map((a) => (
                <PaletteItem key={a.id} icon={a.icon} label={a.label} onAdd={() => addNode(a)} />
              ))}
            </div>
          </div>

          {/* Environment panel removed: studio uses same environment as inbox */}
        </aside>

        <section className="col-span-12 md:col-span-6 relative">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="text-sm text-slate-500">Canvas</div>
            <div className="flex items-center gap-2">
              <div className="text-xs text-slate-500">Zoom</div>
              <input
                type="range"
                min="50"
                max="140"
                step="10"
                value={zoom * 100}
                onChange={(e)=>setZoom(Number(e.target.value)/100)}
                className="w-40"
              />
            </div>
          </div>
          <div
            className="relative h-[calc(100%-2rem)] bg-white rounded-2xl shadow-inner overflow-hidden border"
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseDown={onCanvasDown}
            data-canvas
            ref={canvasRef}
          >
            <GridBackdrop />
            <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
              {flow.edges.map((e) => (
                <Edge key={e.id} edge={e} nodes={flow.nodes} onDelete={() => deleteEdge(e.id)} active={running && activeNodeId && e.from===activeNodeId} />
              ))}
              {flow.nodes.map((n) => (
                <NodeShell
                  key={n.id}
                  node={n}
                  selected={selected === n.id}
                  onMouseDown={onNodeMouseDown}
                  onStartLink={startLink}
                  onCompleteLink={completeLink}
                  onDelete={deleteNode}
                  active={running && activeNodeId === n.id}
                />
              ))}
              {linking && <div className="absolute inset-0 pointer-events-none" />}
            </div>
          </div>
        </section>

        <aside className="col-span-12 md:col-span-3 space-y-3 overflow-y-auto pb-20">
          <div className="border rounded">
            <div className="px-3 py-2 border-b text-sm font-medium flex items-center justify-between">
              <span>Inspector</span>
              {selectedNode && (
                <button className="p-1 rounded hover:bg-slate-100" onClick={()=>deleteNode(selectedNode.id)}>
                  <Trash className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="p-2">
              {!selectedNode && (
                <div className="text-sm text-slate-500">Select a node to edit its settings.</div>
              )}
              {selectedNode && <Inspector node={selectedNode} onUpdate={onUpdateSelected} />}
            </div>
          </div>

          <div className="border rounded">
            <div className="px-3 py-2 border-b text-sm font-medium">Flow settings</div>
            <div className="p-3 space-y-2 text-xs text-slate-600">
              <label className="flex items-center gap-2">
                <input type="checkbox" defaultChecked />
                Enabled
              </label>
              <div>
                • Flows run on your Automation API.
                <br />• Use templates for messages outside the 24‑hour window.
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer className="fixed bottom-3 left-0 right-0 flex justify-center">
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur rounded-full shadow px-3 py-2 border">
          <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/>Validated</span>
          <span className="text-xs text-slate-500">No errors</span>
          <div className="w-px h-5 bg-slate-300 mx-1"/>
          <button className="px-2 py-1 border rounded text-sm" onClick={simulate} disabled={running}><span className="inline-flex items-center gap-1"><Play className="w-4 h-4"/>Test</span></button>
          <button className="px-2 py-1 border rounded text-sm" onClick={()=>alert("Saved!")}><span className="inline-flex items-center gap-1"><Save className="w-4 h-4"/>Save</span></button>
          <button className="px-2 py-1 rounded text-sm bg-blue-600 text-white" onClick={()=>alert("Published!")}><span className="inline-flex items-center gap-1"><CirclePlay className="w-4 h-4"/>Publish</span></button>
        </div>
      </footer>
    </div>
  );
}

function PaletteItem({ icon, label, onAdd }) {
  return (
    <button onClick={onAdd} className="group flex items-center justify-between w-full rounded-xl border p-2 hover:bg-slate-50 transition shadow-sm">
      <div className="flex items-center gap-2">
        <span className="p-2 rounded-lg bg-blue-50 text-blue-600">{icon}</span>
        <span className="text-sm text-left">{label}</span>
      </div>
      <Plus className="w-4 h-4 text-slate-400 group-hover:text-slate-700" />
    </button>
  );
}

function NodeShell({ node, selected, onMouseDown, onStartLink, onCompleteLink, onDelete, active }) {
  const style = { left: node.x, top: node.y };
  const ring = selected ? "ring-2 ring-blue-500" : "ring-1 ring-slate-200";
  const glow = active ? "shadow-[0_0_0_4px_rgba(59,130,246,0.15)]" : "";

  return (
    <div className="absolute select-none" style={style} onMouseDown={(e) => onMouseDown(e, node)}>
      <div className={`rounded-2xl bg-white border ${ring} shadow ${glow} w-[240px]`}>
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${badgeClass(node.type)}`}>{labelForType(node.type)}</span>
          </div>
          <div className="flex items-center gap-1">
            <button className="p-1 rounded hover:bg-slate-50" onClick={(e)=>{e.stopPropagation(); onDelete(node.id);}}>
              <Trash className="w-3.5 h-3.5 text-slate-500" />
            </button>
          </div>
        </div>
        <div className="border-t" />
        <div className="p-3 text-sm text-slate-700 min-h-[56px]">{renderNodeBody(node)}</div>
        <div className="px-3 pb-3 flex items-center justify-between">
          <Port onDown={() => onStartLink(node.id, PORT.IN)} align="left" label="in" hidden={node.type===NODE_TYPES.TRIGGER} />
          {node.type === NODE_TYPES.CONDITION ? (
            <div className="flex items-center gap-3">
              <Port onUp={() => onCompleteLink(node.id, "true")} align="right" color="emerald" label="yes" />
              <Port onUp={() => onCompleteLink(node.id, "false")} align="right" color="rose" label="no" />
            </div>
          ) : (
            <Port onUp={() => onCompleteLink(node.id, PORT.OUT)} align="right" label="out" />
          )}
        </div>
      </div>
    </div>
  );
}

function Port({ align = "left", label, onDown, onUp, color = "blue", hidden }) {
  if (hidden) return <div className="h-4"/>;
  const base = color === "emerald" ? "bg-emerald-500" : color === "rose" ? "bg-rose-500" : "bg-blue-500";
  return (
    <div className={`flex ${align === "left" ? "justify-start" : "justify-end"} items-center w-full`}>
      {align === "left" && <span className="text-[10px] text-slate-400 mr-2 uppercase">{label}</span>}
      <button
        onMouseDown={onDown}
        onMouseUp={onUp}
        className={`w-3 h-3 rounded-full ${base} shadow ring-4 ring-white hover:scale-125 transition`}
        title={label}
      />
      {align === "right" && <span className="text-[10px] text-slate-400 ml-2 uppercase">{label}</span>}
    </div>
  );
}

function labelForType(t){
  return t===NODE_TYPES.TRIGGER?"Trigger":t===NODE_TYPES.CONDITION?"Condition":t===NODE_TYPES.ACTION?"Action":t===NODE_TYPES.DELAY?"Delay":"Exit";
}
function badgeClass(t){
  return t===NODE_TYPES.TRIGGER?"border-blue-200 text-blue-700 bg-blue-50":
         t===NODE_TYPES.CONDITION?"border-amber-200 text-amber-700 bg-amber-50":
         t===NODE_TYPES.ACTION?"border-emerald-200 text-emerald-700 bg-emerald-50":
         t===NODE_TYPES.DELAY?"border-purple-200 text-purple-700 bg-purple-50":"border-slate-200";
}

function renderNodeBody(node){
  switch(node.type){
    case NODE_TYPES.TRIGGER:
      return (
        <div className="space-y-2">
          <div className="text-xs text-slate-500">{String(node.data.source)} / {String(node.data.topic)}</div>
          {node.data.sample && (
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500">Sample payload</summary>
              <pre className="bg-slate-50 p-2 rounded mt-1 overflow-x-auto">{node.data.sample}</pre>
            </details>
          )}
        </div>
      );
    case NODE_TYPES.CONDITION:
      return (
        <div className="text-xs">
          <div className="font-medium text-slate-600 mb-1">Expression</div>
          <div className="font-mono bg-slate-50 rounded p-2">{String(node.data.expression)}</div>
          <div className="mt-2 flex gap-2">
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{node.data.trueLabel || "Yes"}</span>
            <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">{node.data.falseLabel || "No"}</span>
          </div>
        </div>
      );
    case NODE_TYPES.ACTION:
      return (
        <div className="text-xs space-y-1">
          <div className="text-slate-500">{String(node.data.type)}</div>
          {node.data.template_name && <div>template: <span className="font-mono">{String(node.data.template_name)}</span></div>}
          {node.data.text && <div className="line-clamp-2">“{String(node.data.text)}”</div>}
        </div>
      );
    case NODE_TYPES.DELAY:
      return <div className="text-xs">Wait <span className="font-semibold">{String(node.data.minutes)}</span> minutes</div>;
    default:
      return null;
  }
}

function GridBackdrop(){
  return (
    <div className="absolute inset-0">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,_#eef2ff_1px,transparent_1px),linear-gradient(to_bottom,_#eef2ff_1px,transparent_1px)] bg-[size:24px_24px]"/>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(59,130,246,0.06),transparent_30%),radial-gradient(circle_at_80%_60%,rgba(14,165,233,0.06),transparent_35%)]"/>
    </div>
  );
}

function Edge({ edge, nodes, onDelete, active }){
  const from = nodes.find((n)=>n.id===edge.from);
  const to = nodes.find((n)=>n.id===edge.to);
  if(!from || !to) return null;
  const x1 = from.x + 230;
  const y1 = from.y + 100;
  const x2 = to.x + 10;
  const y2 = to.y + 100;
  const d = makePath(x1,y1,x2,y2);
  return (
    <svg className="absolute overflow-visible pointer-events-none" style={{left:0, top:0}}>
      <path d={d} className={`fill-none ${active ? 'stroke-blue-300' : 'stroke-slate-300'}`} strokeWidth={active?3:2} />
      <g className="pointer-events-auto" onClick={onDelete}>
        <circle cx={(x1+x2)/2} cy={(y1+y2)/2} r="6" className="fill-white stroke-slate-300 hover:stroke-rose-500 hover:fill-rose-50 cursor-pointer" />
      </g>
    </svg>
  );
}

function makePath(x1,y1,x2,y2){
  const c = 0.4 * Math.abs(x2-x1);
  return `M ${x1} ${y1} C ${x1+c} ${y1}, ${x2-c} ${y2}, ${x2} ${y2}`;
}

function Inspector({ node, onUpdate }){
  const [templates, setTemplates] = React.useState(null);
  const [loadingTpl, setLoadingTpl] = React.useState(false);
  React.useEffect(()=>{
    const load = async ()=>{
      try {
        setLoadingTpl(true);
        const mod = await import('./api');
        const api = mod.default;
        const res = await api.get('/whatsapp/templates');
        const arr = Array.isArray(res.data) ? res.data : [];
        setTemplates(arr);
      } catch {
        setTemplates([]);
      } finally { setLoadingTpl(false); }
    };
    // Only load when inspector rendered for an Action node to reduce noise
    if (node?.type === NODE_TYPES.ACTION) load();
  }, [node?.id, node?.type]);
  if(node.type === NODE_TYPES.TRIGGER){
    const isShopify = String(node.data.source||'').toLowerCase() === 'shopify' || !node.data.source;
    const selected = SHOPIFY_EVENTS.find(ev => ev.topic === node.data.topic) || null;
    return (
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-xs text-slate-500 mb-1">Provider</div>
          <select
            className="w-full border rounded px-2 py-1"
            value={isShopify ? 'shopify' : (node.data.source || 'whatsapp')}
            onChange={(e)=>{
              const v = e.target.value;
              if (v === 'shopify') onUpdate({ source: 'shopify' });
              else onUpdate({ source: v, topic: v==='whatsapp' ? 'message' : (node.data.topic||'') });
            }}
          >
            <option value="shopify">Shopify</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </div>

        {isShopify ? (
          <>
            <div>
              <div className="text-xs text-slate-500 mb-1">Shopify Event</div>
              <select
                className="w-full border rounded px-2 py-1"
                value={selected?.topic || node.data.topic || ''}
                onChange={(e)=>{
                  const ev = SHOPIFY_EVENTS.find(x=>x.topic===e.target.value);
                  if (ev) onUpdate({ source: 'shopify', topic: ev.topic, sample: ev.sample });
                  else onUpdate({ source: 'shopify', topic: e.target.value });
                }}
              >
                <option value="">Select event…</option>
                {SHOPIFY_EVENTS.map(ev => (
                  <option key={ev.id} value={ev.topic}>{ev.label}</option>
                ))}
              </select>
            </div>

            {!!selected && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Variables</div>
                <div className="flex flex-wrap gap-1">
                  {selected.variables.map(v => (
                    <button
                      key={v}
                      type="button"
                      className="px-2 py-0.5 rounded border text-xs hover:bg-slate-50"
                      title="Click to copy"
                      onClick={()=>{ try { navigator.clipboard.writeText(`{{ ${v} }}`); } catch(_) {} }}
                    >{v}</button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-xs text-slate-500 mb-1">Sample Payload</div>
              <textarea className="w-full border rounded px-2 py-1" value={node.data.sample||selected?.sample||""} onChange={(e)=>onUpdate({sample:e.target.value})} rows={5} />
            </div>
          </>
        ) : (
          <>
            <div>
              <div className="text-xs text-slate-500 mb-1">Topic</div>
              <input className="w-full border rounded px-2 py-1" value={node.data.topic||""} onChange={(e)=>onUpdate({topic:e.target.value})} />
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">Sample Payload</div>
              <textarea className="w-full border rounded px-2 py-1" value={node.data.sample||""} onChange={(e)=>onUpdate({sample:e.target.value})} rows={5} />
            </div>
          </>
        )}
        {runtimeSection(node)}
      </div>
    );
  }
  if(node.type === NODE_TYPES.CONDITION){
    return (
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-xs text-slate-500 mb-1">Expression (Jinja / JSONLogic)</div>
          <textarea className="w-full border rounded px-2 py-1" value={node.data.expression||""} onChange={(e)=>onUpdate({expression:e.target.value})} rows={3} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-xs text-slate-500 mb-1">Yes label</div>
            <input className="w-full border rounded px-2 py-1" value={node.data.trueLabel||"Yes"} onChange={(e)=>onUpdate({trueLabel:e.target.value})} />
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">No label</div>
            <input className="w-full border rounded px-2 py-1" value={node.data.falseLabel||"No"} onChange={(e)=>onUpdate({falseLabel:e.target.value})} />
          </div>
        </div>
        {runtimeSection(node)}
      </div>
    );
  }
  if(node.type === NODE_TYPES.ACTION){
    const isTemplate = String(node.data.type||"") === "send_whatsapp_template";
    return (
      <div className="text-sm">
        <div className="flex gap-2 mb-2">
          <button className={`px-2 py-1 border rounded ${isTemplate? 'bg-blue-50 border-blue-200' : ''}`} onClick={()=>onUpdate({ type: 'send_whatsapp_template' })}>Template</button>
          <button className={`px-2 py-1 border rounded ${!isTemplate? 'bg-blue-50 border-blue-200' : ''}`} onClick={()=>onUpdate({ type: 'send_whatsapp_text' })}>Text</button>
        </div>
        {isTemplate ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-slate-500 mb-1">To</div>
              <input className="w-full border rounded px-2 py-1" value={node.data.to||""} onChange={(e)=>onUpdate({to:e.target.value})} />
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">Template</div>
              {templates && templates.length > 0 ? (
                <select className="w-full border rounded px-2 py-1" value={`${node.data.template_name||''}|${node.data.language||''}`}
                  onChange={(e)=>{
                    const [name, lang] = String(e.target.value||'|').split('|');
                    onUpdate({ template_name: name, language: lang });
                  }}>
                  <option value="|">Select template…</option>
                  {templates.map((t)=>{
                    const val = `${t.name||''}|${t.language||''}`;
                    const label = `${t.name||''} (${t.language||''})`;
                    return <option key={val} value={val}>{label}</option>;
                  })}
                </select>
              ) : (
                <input className="w-full border rounded px-2 py-1" placeholder={loadingTpl? 'Loading templates…' : 'Template name'} value={node.data.template_name||""} onChange={(e)=>onUpdate({template_name:e.target.value})} />
              )}
            </div>
            {!templates && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Language</div>
                <input className="w-full border rounded px-2 py-1" value={node.data.language||"en"} onChange={(e)=>onUpdate({language:e.target.value})} />
              </div>
            )}
            <div>
              <div className="text-xs text-slate-500 mb-1">Body variable 1</div>
              <input className="w-full border rounded px-2 py-1" placeholder="{{ order_number }}" onChange={(e)=>{
                const comps = [{ type:"body", parameters:[{ type:"text", text:e.target.value||"" }] }];
                onUpdate({ components: comps });
              }} />
            </div>
            {Array.isArray(templates) && templates.length>0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500">Placeholders</summary>
                <div className="mt-1 space-y-1">
                  {(templates.find(t=> (t.name===node.data.template_name && t.language===node.data.language))?.components||[]).map((c, idx)=>{
                    if ((c.type||'').toLowerCase() !== 'body') return null;
                    const params = c.parameters||[];
                    const count = params.length||1;
                    const arr = Array.from({length: count}, (_,i)=>i+1);
                    return (
                      <div key={`comp-${idx}`}>Body variables: {arr.map(i=> <span key={i} className="inline-block px-1.5 py-0.5 m-0.5 rounded border text-[11px]">{{`{{ ${i} }}`}}</span>)}</div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-slate-500 mb-1">To</div>
              <input className="w-full border rounded px-2 py-1" value={node.data.to||""} onChange={(e)=>onUpdate({to:e.target.value})} />
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">Message</div>
              <textarea className="w-full border rounded px-2 py-1" rows={5} value={node.data.text||""} onChange={(e)=>onUpdate({text:e.target.value})} />
            </div>
          </div>
        )}
        {runtimeSection(node)}
      </div>
    );
  }
  if(node.type === NODE_TYPES.DELAY){
    return (
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-xs text-slate-500 mb-1">Minutes</div>
          <input type="number" className="w-full border rounded px-2 py-1" value={node.data.minutes||0} onChange={(e)=>onUpdate({minutes:Number(e.target.value||0)})} />
        </div>
        {runtimeSection(node)}
      </div>
    );
  }
  return <div className="text-sm text-slate-500">No settings.</div>;
}

function runtimeSection(node){
  const log = node?.data?.runtime;
  if(!log) return null;
  return (
    <div className="mt-4 space-y-2 text-xs">
      <div className="font-medium text-slate-600">Runtime</div>
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 rounded border ${log.status==='error' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>{String(log.status||'ok')}</span>
        {log.error && <span className="text-rose-600">{String(log.error)}</span>}
      </div>
      {log.input && (
        <div>
          <div className="text-slate-500 mb-1">Input</div>
          <pre className="bg-slate-50 p-2 rounded overflow-x-auto">{safeJson(log.input)}</pre>
        </div>
      )}
      {log.output && (
        <div>
          <div className="text-slate-500 mb-1">Output</div>
          <pre className="bg-slate-50 p-2 rounded overflow-x-auto">{safeJson(log.output)}</pre>
        </div>
      )}
    </div>
  );
}

function safeJson(obj){
  try { return JSON.stringify(obj||{}, null, 2); } catch { return String(obj||''); }
}

