import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";

function formatInt(n) {
  try {
    return new Intl.NumberFormat().format(Number(n || 0));
  } catch {
    return String(n || 0);
  }
}

function formatMoney(m) {
  try {
    const v = Number(m?.value || 0);
    const cur = m?.currency || "";
    const num = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    return cur ? `${cur} ${num}` : num;
  } catch {
    return "";
  }
}

export default function AutomationCustomersTab() {
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState(() => {
    try {
      return localStorage.getItem("automation_customers_store") || "";
    } catch {
      return "";
    }
  });

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [pageInfo, setPageInfo] = useState(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [customers, setCustomers] = useState([]);
  const [totalCount, setTotalCount] = useState(null);
  const [nextPageInfo, setNextPageInfo] = useState(null);
  const [prevPageInfo, setPrevPageInfo] = useState(null);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const selectAllChecked = useMemo(() => {
    if (!customers.length) return false;
    return customers.every((c) => selectedIds.has(String(c.id)));
  }, [customers, selectedIds]);

  const lastFetchKeyRef = useRef("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q || ""), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    // Reset pagination when searching
    setPageInfo(null);
  }, [debouncedQ, storeId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get("/shopify-stores");
        const arr = Array.isArray(res?.data) ? res.data : [];
        if (!alive) return;
        setStores(arr);
        if (!storeId && arr.length) {
          setStoreId(String(arr[0].id || ""));
        }
      } catch {
        // If backend doesn't expose multi-store, just continue with default store.
        if (!alive) return;
        setStores([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      if (storeId) localStorage.setItem("automation_customers_store", storeId);
    } catch {}
  }, [storeId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr("");
      setLoading(true);
      const key = JSON.stringify({ storeId, debouncedQ, pageInfo });
      lastFetchKeyRef.current = key;
      try {
        const res = await api.get("/shopify-customers", {
          params: {
            ...(storeId ? { store: storeId } : {}),
            limit: 50,
            ...(pageInfo ? { page_info: pageInfo } : {}),
            ...(debouncedQ && debouncedQ.trim() ? { q: debouncedQ.trim() } : {}),
          },
        });
        if (!alive) return;
        if (lastFetchKeyRef.current !== key) return;
        setCustomers(Array.isArray(res?.data?.customers) ? res.data.customers : []);
        setTotalCount(typeof res?.data?.total_count === "number" ? res.data.total_count : null);
        setNextPageInfo(res?.data?.next_page_info || null);
        setPrevPageInfo(res?.data?.prev_page_info || null);
        setSelectedIds(new Set()); // reset selection per page
      } catch (e) {
        if (!alive) return;
        const msg = e?.response?.data?.detail || e?.message || "Failed to load customers";
        setErr(String(msg));
        setCustomers([]);
        setTotalCount(null);
        setNextPageInfo(null);
        setPrevPageInfo(null);
        setSelectedIds(new Set());
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [storeId, debouncedQ, pageInfo]);

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selectAllChecked) {
        customers.forEach((c) => next.delete(String(c.id)));
      } else {
        customers.forEach((c) => next.add(String(c.id)));
      }
      return next;
    });
  };

  const toggleRow = (id) => {
    const key = String(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="h-full w-full bg-white overflow-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-2xl font-semibold text-slate-900">Customers</div>
            <div className="text-sm text-slate-600 mt-1">
              {typeof totalCount === "number" ? (
                <>
                  <span className="font-semibold">{formatInt(totalCount)}</span> customers
                  <div className="text-xs text-slate-500 mt-1">100% of your customer base</div>
                </>
              ) : (
                <span className="text-slate-500">Customers list</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {stores.length > 0 && (
              <select
                className="border rounded px-2 py-1 text-sm bg-white"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                title="Shopify store"
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Segment builder (UI-only) */}
        <div className="mt-5 border rounded-xl bg-white">
          <div className="px-4 py-3 border-b">
            <div className="text-xs text-slate-500">FROM customers</div>
            <div className="mt-2 font-mono text-xs text-slate-700 bg-slate-50 border rounded px-3 py-2 overflow-x-auto">
              SHOW customer_name, note, email_subscription_status, location, orders, amount_spent
              <br />
              WHERE
              <br />
              ORDER BY updated_at
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-sm text-slate-700">To create a segment, choose a template.</div>
            <div className="mt-2">
              <textarea
                className="w-full border rounded px-3 py-2 text-sm"
                rows={2}
                placeholder="Describe your segment"
                disabled
              />
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="mt-5">
          <div className="text-sm font-medium text-slate-800 mb-2">Search customers</div>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 border rounded px-3 py-2 text-sm"
              placeholder="Search customers"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="px-3 py-2 text-sm border rounded" onClick={() => setQ("")} disabled={!q}>
              Clear
            </button>
          </div>
          {err && <div className="mt-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 px-3 py-2 rounded">{err}</div>}
        </div>

        {/* Table */}
        <div className="mt-5 border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={selectAllChecked} onChange={toggleSelectAll} />
              Select all customers
            </label>

            <div className="flex items-center gap-2">
              <button className="px-3 py-1.5 text-sm border rounded" onClick={() => setPageInfo(prevPageInfo)} disabled={!prevPageInfo || loading}>
                Prev
              </button>
              <button className="px-3 py-1.5 text-sm border rounded" onClick={() => setPageInfo(nextPageInfo)} disabled={!nextPageInfo || loading}>
                Next
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[920px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="w-10 px-4 py-2 text-left"> </th>
                  <th className="px-4 py-2 text-left">Customer name</th>
                  <th className="px-4 py-2 text-left">Note</th>
                  <th className="px-4 py-2 text-left">Email subscription</th>
                  <th className="px-4 py-2 text-left">Location</th>
                  <th className="px-4 py-2 text-left">Orders</th>
                  <th className="px-4 py-2 text-left">Amount spent</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading && (
                  <tr>
                    <td className="px-4 py-3 text-slate-500" colSpan={7}>
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && customers.length === 0 && (
                  <tr>
                    <td className="px-4 py-3 text-slate-500" colSpan={7}>
                      No customers.
                    </td>
                  </tr>
                )}
                {!loading &&
                  customers.map((c) => {
                    const checked = selectedIds.has(String(c.id));
                    return (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <input type="checkbox" checked={checked} onChange={() => toggleRow(c.id)} />
                        </td>
                        <td className="px-4 py-3">
                          <button className="text-left w-full" onClick={() => toggleRow(c.id)}>
                            <div className="font-medium text-slate-900">{c.customer_name || "(no name)"}</div>
                          </button>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{c.note ? String(c.note).slice(0, 80) : ""}</td>
                        <td className="px-4 py-3 text-slate-700">{c.email_subscription_status || "-"}</td>
                        <td className="px-4 py-3 text-slate-700">{c.location || ""}</td>
                        <td className="px-4 py-3 text-slate-700">{typeof c.orders === "number" ? c.orders : 0}</td>
                        <td className="px-4 py-3 text-slate-900 whitespace-nowrap">{formatMoney(c.amount_spent)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}


