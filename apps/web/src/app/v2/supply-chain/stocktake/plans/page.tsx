"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, getUser } from "@/lib/v2-auth";

type CountScope = "ALL" | "DAILY" | "WEEKLY" | "SELECTED";
type Rule = "ALL_ENABLED" | "HISTORICAL_MOVEMENT" | "PERIOD_MOVEMENT_OR_OPENING" | "BOOK_NONZERO_AS_OF" | "FIXED_PLAN_PRODUCTS";
type Product = { id: string; code: string; name: string; inventoryUnit: string | null; unit: string };
type Warehouse = { id: string; code: string; name: string };
type Plan = {
  id: string; no: string; name: string; status: "ENABLED" | "DISABLED"; warehouseId: string | null;
  countScope: CountScope; selectionRule: Rule; periodUnit: "DAY" | "WEEK" | "MONTH" | null;
  note: string | null; rowVersion: number; items: Array<{ productId: string; product: Product }>;
};
type PolicyRow = {
  id: string | null; product: Product; canCount: boolean; defaultIncluded: boolean;
  reason: string | null; rowVersion: number;
};

const field = "w-full rounded-lg border border-border bg-white p-2";
const scopeLabel: Record<CountScope, string> = { ALL: "全部盘点", DAILY: "日盘", WEEKLY: "周盘", SELECTED: "指定盘点" };
const ruleLabel: Record<Rule, string> = {
  ALL_ENABLED: "全部启用商品", HISTORICAL_MOVEMENT: "历史有实物变动", PERIOD_MOVEMENT_OR_OPENING: "期间期初或发生额",
  BOOK_NONZERO_AS_OF: "今日账面不为零", FIXED_PLAN_PRODUCTS: "固定商品",
};
const periodLabel = { DAY: "日", WEEK: "周", MONTH: "月" } as const;

function writeStoragePrefix(userId: string) {
  const tenant = JSON.parse(localStorage.getItem("tenant") || "null");
  if (!tenant?.id || !userId) throw new Error("缺少当前租户或账号信息");
  return `dj:stocktake-plan-write:${tenant.id}:${userId}`;
}

function contract(scope: CountScope, selectedRule: Rule) {
  if (scope === "ALL") return { selectionRule: "ALL_ENABLED" as const, periodUnit: null };
  if (scope === "DAILY") return { selectionRule: "PERIOD_MOVEMENT_OR_OPENING" as const, periodUnit: "DAY" as const };
  if (scope === "WEEKLY") return { selectionRule: "PERIOD_MOVEMENT_OR_OPENING" as const, periodUnit: "WEEK" as const };
  if (selectedRule === "PERIOD_MOVEMENT_OR_OPENING") return { selectionRule: selectedRule, periodUnit: "MONTH" as const };
  return { selectionRule: selectedRule, periodUnit: null };
}

export default function WarehouseStocktakePlansPage() {
  const user = getUser();
  const canAudit = ["SUPPLY_CHAIN", "SUPER_ADMIN", "ADMIN"].includes(user?.role || "");
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [name, setName] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [scope, setScope] = useState<CountScope>("ALL");
  const [selectedRule, setSelectedRule] = useState<Rule>("FIXED_PLAN_PRODUCTS");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [policyWarehouseId, setPolicyWarehouseId] = useState("");
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [policyDrafts, setPolicyDrafts] = useState<Record<string, { canCount: boolean; defaultIncluded: boolean; reason: string }>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [planResultUnknown, setPlanResultUnknown] = useState(false);
  const [corruptStorageKeys, setCorruptStorageKeys] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const effective = useMemo(() => contract(scope, selectedRule), [scope, selectedRule]);
  const submittingPlan = useRef(false);
  const pendingPlan = useRef<{ body: string } | null>(null);
  const pendingPlanUpdates = useRef(new Map<string, { planId: string; body: string }>());
  const pendingPolicies = useRef(new Map<string, { warehouseId: string; productId: string; body: string }>());
  const policyLoadSequence = useRef(0);
  const currentPolicyWarehouse = useRef("");

  useEffect(() => {
    currentPolicyWarehouse.current = policyWarehouseId;
  }, [policyWarehouseId]);

  useEffect(() => {
    try {
      const prefix = writeStoragePrefix(user?.id || "");
      const planRaw = sessionStorage.getItem(`${prefix}:plan`);
      if (planRaw) {
        const restored = JSON.parse(planRaw);
        const body = JSON.parse(restored.body);
        pendingPlan.current = restored;
        setName(body.name || ""); setWarehouseId(body.warehouseId || ""); setScope(body.countScope || "ALL");
        setSelectedRule(body.selectionRule || "FIXED_PLAN_PRODUCTS"); setProductIds(body.productIds || []);
        setPlanResultUnknown(true);
        setError("已恢复结果未确认的方案创建，请重放原请求");
      }
      let restoredUpdates = 0;
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith(`${prefix}:`)) continue;
        const request = JSON.parse(sessionStorage.getItem(key) || "null");
        if (key.startsWith(`${prefix}:policy:`) && request?.warehouseId && request?.productId && request?.body) {
          JSON.parse(request.body); pendingPolicies.current.set(`${request.warehouseId}:${request.productId}`, request);
        }
        if (key.startsWith(`${prefix}:update:`) && request?.planId && request?.body) {
          JSON.parse(request.body); pendingPlanUpdates.current.set(request.planId, request); restoredUpdates += 1;
        }
      }
      if (restoredUpdates) setNotice(`已恢复 ${restoredUpdates} 个结果未确认的方案更新；请点击对应方案重放原请求`);
    } catch (reason: any) {
      const prefix = (() => { try { return writeStoragePrefix(user?.id || ""); } catch { return ""; } })();
      const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => Boolean(key && (!prefix || key.startsWith(prefix))));
      setCorruptStorageKeys(keys); setError(`${reason.message || "写入恢复记录损坏"}；已冻结写入，请先核实结果再清理恢复记录`);
    }
  }, [user?.id]);

  async function load() {
    const [options, planRows] = await Promise.all([
      apiFetch<{ warehouses: Warehouse[]; products: Product[] }>("/api/warehouse-stocktakes/options"),
      apiFetch<Plan[]>("/api/warehouse-stocktake-plans"),
    ]);
    setWarehouses(options.warehouses);
    setProducts(options.products);
    setPlans(planRows);
    setLoadFailed(false);
    setPolicyWarehouseId((current) => current || options.warehouses[0]?.id || "");
  }

  useEffect(() => { void load().catch((reason) => { setLoadFailed(true); setError(reason.message); }).finally(() => setLoading(false)); }, []);

  async function loadPolicies(targetWarehouseId: string) {
    const sequence = ++policyLoadSequence.current;
    const result = await apiFetch<{ rows: PolicyRow[] }>(`/api/warehouse-stocktake-plans/policies/${targetWarehouseId}`);
    if (sequence !== policyLoadSequence.current || targetWarehouseId !== currentPolicyWarehouse.current) return;
    setPolicies(result.rows);
    setPolicyDrafts(Object.fromEntries(result.rows.map((row) => [row.product.id, {
      canCount: row.canCount, defaultIncluded: row.defaultIncluded, reason: row.reason || "",
    }])));
  }

  useEffect(() => {
    ++policyLoadSequence.current;
    setPolicies([]);
    setPolicyDrafts({});
    if (!policyWarehouseId) return;
    void loadPolicies(policyWarehouseId).catch((reason) => setError(reason.message));
  }, [policyWarehouseId]);

  async function createPlan() {
    if (!canAudit || loading || loadFailed || corruptStorageKeys.length) return;
    if (submittingPlan.current) return;
    if (!pendingPlan.current && !name.trim()) return setError("请填写方案名称");
    if (!pendingPlan.current && effective.selectionRule === "FIXED_PLAN_PRODUCTS" && !productIds.length) return setError("固定商品方案至少选择一个商品");
    submittingPlan.current = true;
    setBusy(true); setError(""); setNotice("");
    let writeConfirmed = false;
    try {
      const request = pendingPlan.current || { body: JSON.stringify({
          requestKey: crypto.randomUUID(), name: name.trim(), warehouseId: warehouseId || null,
          countScope: scope, selectionRule: effective.selectionRule, periodUnit: effective.periodUnit,
          productIds: effective.selectionRule === "FIXED_PLAN_PRODUCTS" ? productIds : [], note: null,
        }) };
      pendingPlan.current = request;
      const storageKey = `${writeStoragePrefix(user?.id || "")}:plan`;
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      await apiFetch("/api/warehouse-stocktake-plans", { method: "POST", body: request.body });
      writeConfirmed = true;
      pendingPlan.current = null;
      sessionStorage.removeItem(storageKey);
      setPlanResultUnknown(false);
      setName(""); setProductIds([]); setNotice("盘点方案已创建");
      try { await load(); }
      catch (reason: any) { setError(`方案已创建，但列表刷新失败：${reason.message || "请手动刷新"}`); }
    } catch (reason: any) {
      if (!writeConfirmed && reason.status >= 400 && reason.status < 500) {
        pendingPlan.current = null;
        sessionStorage.removeItem(`${writeStoragePrefix(user?.id || "")}:plan`);
        setPlanResultUnknown(false);
      } else if (!writeConfirmed) setPlanResultUnknown(true);
      setError(!writeConfirmed && pendingPlan.current ? `${reason.message || "创建失败"}；结果未确认，再次点击将重放原请求` : reason.message || "创建失败");
    } finally { submittingPlan.current = false; setBusy(false); }
  }

  async function togglePlan(plan: Plan) {
    if (!canAudit || corruptStorageKeys.length) return;
    setBusy(true); setError("");
    const pending = pendingPlanUpdates.current.get(plan.id) || { planId: plan.id, body: JSON.stringify({
      name: plan.name, warehouseId: plan.warehouseId, countScope: plan.countScope,
      selectionRule: plan.selectionRule, periodUnit: plan.periodUnit,
      productIds: plan.items.map((item) => item.productId), note: plan.note,
      rowVersion: plan.rowVersion, status: plan.status === "ENABLED" ? "DISABLED" : "ENABLED", requestKey: crypto.randomUUID(),
    }) };
    pendingPlanUpdates.current.set(plan.id, pending);
    const storageKey = `${writeStoragePrefix(user?.id || "")}:update:${plan.id}`;
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
    let writeConfirmed = false;
    try {
      await apiFetch(`/api/warehouse-stocktake-plans/${plan.id}`, { method: "PATCH", body: pending.body });
      writeConfirmed = true; pendingPlanUpdates.current.delete(plan.id); sessionStorage.removeItem(storageKey);
      await load(); setNotice(plan.status === "ENABLED" ? "方案已停用" : "方案已启用");
    } catch (reason: any) {
      if (!writeConfirmed && reason.status >= 400 && reason.status < 500) { pendingPlanUpdates.current.delete(plan.id); sessionStorage.removeItem(storageKey); }
      setError(!writeConfirmed && pendingPlanUpdates.current.has(plan.id) ? `${reason.message || "更新失败"}；结果未确认，再次点击将重放原请求` : reason.message || "更新失败");
    }
    finally { setBusy(false); }
  }

  async function savePolicy(row: PolicyRow) {
    if (!canAudit || corruptStorageKeys.length) return;
    const draft = policyDrafts[row.product.id];
    if (!draft) return;
    if (!draft.canCount && draft.reason.trim().length < 2) return setError("禁止盘点时必须填写至少2个字的原因");
    if (draft.reason.trim().length > 500) return setError("政策原因不能超过500字");
    const pendingKey = `${policyWarehouseId}:${row.product.id}`;
    const existingRequest = pendingPolicies.current.get(pendingKey);
    if (existingRequest && existingRequest.warehouseId !== policyWarehouseId) return setError("仓库已切换，不能把旧政策写入新仓库");
    const request = existingRequest || {
      warehouseId: policyWarehouseId,
      productId: row.product.id,
      body: JSON.stringify({ ...draft, reason: draft.reason.trim() || null, rowVersion: row.rowVersion, requestKey: crypto.randomUUID() }),
    };
    pendingPolicies.current.set(pendingKey, request);
    const policyStorageKey = `${writeStoragePrefix(user?.id || "")}:policy:${request.warehouseId}:${request.productId}`;
    sessionStorage.setItem(policyStorageKey, JSON.stringify(request));
    setBusy(true); setError("");
    let writeConfirmed = false;
    try {
      await apiFetch(`/api/warehouse-stocktake-plans/policies/${request.warehouseId}/${request.productId}`, {
        method: "PUT", body: request.body,
      });
      writeConfirmed = true;
      pendingPolicies.current.delete(pendingKey);
      sessionStorage.removeItem(policyStorageKey);
      setNotice(`已保存「${row.product.name}」的盘点政策`);
      try { await loadPolicies(request.warehouseId); }
      catch (reason: any) { setError(`政策已保存，但回读失败：${reason.message || "请重新选择仓库"}`); }
    } catch (reason: any) {
      if (!writeConfirmed && reason.status >= 400 && reason.status < 500) {
        pendingPolicies.current.delete(pendingKey);
        sessionStorage.removeItem(policyStorageKey);
      }
      setError(!writeConfirmed && pendingPolicies.current.has(pendingKey) ? `${reason.message || "政策保存失败"}；结果未确认，请重放原请求` : reason.message || "政策保存失败");
    }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-6xl space-y-5 p-4">
    <header className="space-y-2">
      <Link className="text-caption underline" href="/v2/supply-chain/stocktake/work?from=count">返回盘点作业</Link>
      <h1 className="text-h1">盘点方案与商品政策</h1>
      <p className="text-caption text-gray2">仅使用库存单位；固定方案、默认纳入和禁止盘点会在创建前由服务器重新校验。</p>
    </header>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
    {corruptStorageKeys.length > 0 && <button className="rounded border border-red-400 px-3 py-1.5 text-red-700" onClick={() => { corruptStorageKeys.forEach((key) => sessionStorage.removeItem(key)); pendingPlan.current = null; pendingPlanUpdates.current.clear(); pendingPolicies.current.clear(); setCorruptStorageKeys([]); setPlanResultUnknown(false); setError("恢复记录已清理；请先在单据列表核实旧请求结果，再进行新写入"); }}>核实后清除损坏记录</button>}
    {loadFailed && <button className="rounded border px-3 py-1.5" onClick={() => { setLoading(true); setError(""); void load().catch((reason) => { setLoadFailed(true); setError(reason.message); }).finally(() => setLoading(false)); }}>重试加载</button>}
    {notice && <p role="status" className="rounded bg-green-50 p-3">{notice}</p>}

    {canAudit && <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="text-h2">新建盘点方案</h2>
      <fieldset disabled={planResultUnknown || corruptStorageKeys.length > 0} className="space-y-3"><div className="grid gap-3 md:grid-cols-3">
        <label>方案名称<input aria-label="方案名称" className={field} value={name} disabled={planResultUnknown} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
        <label>适用仓库<select aria-label="方案仓库" className={field} value={warehouseId} disabled={planResultUnknown} onChange={(event) => setWarehouseId(event.target.value)}><option value="">全部仓库</option>{warehouses.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label>盘点范围<select aria-label="方案范围" className={field} value={scope} disabled={planResultUnknown} onChange={(event) => setScope(event.target.value as CountScope)}><option value="ALL">全部盘点</option><option value="DAILY">日盘</option><option value="WEEKLY">周盘</option><option value="SELECTED">指定盘点</option></select></label>
      </div>
      {scope === "SELECTED" && <label>圈定规则<select aria-label="方案圈定规则" className={field} value={selectedRule} onChange={(event) => setSelectedRule(event.target.value as Rule)}><option value="FIXED_PLAN_PRODUCTS">固定商品</option><option value="HISTORICAL_MOVEMENT">历史有实物变动</option><option value="BOOK_NONZERO_AS_OF">今日账面不为零</option><option value="PERIOD_MOVEMENT_OR_OPENING">本月期初或发生额</option></select></label>}
      {scope === "SELECTED" && effective.selectionRule === "FIXED_PLAN_PRODUCTS" && <div className="grid max-h-56 gap-2 overflow-auto rounded border p-3 sm:grid-cols-2">{products.map((product) => <label key={product.id} className="text-caption"><input type="checkbox" checked={productIds.includes(product.id)} onChange={(event) => setProductIds((ids) => event.target.checked ? [...ids, product.id] : ids.filter((id) => id !== product.id))} /> {product.code} {product.name} · {product.inventoryUnit || product.unit}</label>)}</div>}
      </fieldset><button disabled={busy || loading || loadFailed || corruptStorageKeys.length > 0} className="rounded bg-ink px-4 py-2 text-white" onClick={() => void createPlan()}>{planResultUnknown ? "重试原方案请求" : "创建方案"}</button>
      <div className="overflow-auto"><table className="w-full text-left text-caption"><thead><tr><th>编号</th><th>名称</th><th>范围/规则</th><th>固定商品</th><th>状态</th><th>操作</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id}><td>{plan.no}</td><td>{plan.name}</td><td>{scopeLabel[plan.countScope]} · {ruleLabel[plan.selectionRule]}{plan.periodUnit ? ` · ${periodLabel[plan.periodUnit]}` : ""}</td><td>{plan.items.length}</td><td>{plan.status === "ENABLED" ? "启用" : "停用"}</td><td><button className="underline" disabled={busy || corruptStorageKeys.length > 0} onClick={() => void togglePlan(plan)}>{pendingPlanUpdates.current.has(plan.id) ? "重试原更新" : plan.status === "ENABLED" ? "停用" : "启用"}</button></td></tr>)}</tbody></table></div>
    </section>}

    {!canAudit && <section className="rounded-xl border border-border p-4"><h2 className="text-h2">盘点方案（只读）</h2><ul>{plans.map((plan) => <li key={plan.id}>{plan.no} · {plan.name} · {scopeLabel[plan.countScope]} · {plan.status === "ENABLED" ? "启用" : "停用"}</li>)}</ul></section>}

    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="text-h2">商品盘点政策</h2>
      <label>仓库<select aria-label="政策仓库" className={field} value={policyWarehouseId} disabled={busy || corruptStorageKeys.length > 0} onChange={(event) => { const next = event.target.value; ++policyLoadSequence.current; currentPolicyWarehouse.current = next; setPolicies([]); setPolicyDrafts({}); setPolicyWarehouseId(next); }}>{warehouses.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <div className="overflow-auto"><table className="w-full text-left text-caption"><thead><tr><th>商品</th><th>库存单位</th><th>允许盘点</th><th>自动规则默认纳入</th><th>原因</th>{canAudit && <th>操作</th>}</tr></thead><tbody>{policies.map((row) => { const draft = policyDrafts[row.product.id] || { canCount: row.canCount, defaultIncluded: row.defaultIncluded, reason: row.reason || "" }; return <tr key={row.product.id}><td>{row.product.code} {row.product.name}</td><td>{row.product.inventoryUnit || row.product.unit}</td><td><input aria-label={`${row.product.name}允许盘点`} type="checkbox" disabled={!canAudit || corruptStorageKeys.length > 0} checked={draft.canCount} onChange={(event) => setPolicyDrafts((rows) => ({ ...rows, [row.product.id]: { ...draft, canCount: event.target.checked } }))} /></td><td><input aria-label={`${row.product.name}默认纳入`} type="checkbox" disabled={!canAudit || corruptStorageKeys.length > 0} checked={draft.defaultIncluded} onChange={(event) => setPolicyDrafts((rows) => ({ ...rows, [row.product.id]: { ...draft, defaultIncluded: event.target.checked } }))} /></td><td><input aria-label={`${row.product.name}政策原因`} className={field} disabled={!canAudit || corruptStorageKeys.length > 0} maxLength={500} value={draft.reason} onChange={(event) => setPolicyDrafts((rows) => ({ ...rows, [row.product.id]: { ...draft, reason: event.target.value } }))} /></td>{canAudit && <td><button disabled={busy || corruptStorageKeys.length > 0} className="underline" onClick={() => void savePolicy(row)}>保存政策</button></td>}</tr>; })}</tbody></table></div>
    </section>
  </main>;
}
