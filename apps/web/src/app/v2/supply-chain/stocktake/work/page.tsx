"use client";
import { SearchableSelect } from "@/components/v2/searchable-select";

import Link from "next/link";
import { useRouter } from "next/navigation";
import sheet from "@/components/v2/document-sheet.module.css";
import { useEffect, useRef, useState } from "react";
import { apiFetch, getUser } from "@/lib/v2-auth";
import { ConfirmSheet, useConfirmSheet } from "@/components/v2/confirm-sheet";
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from "@/components/v2/supply-chain-shell";
import {
  previewWarehouseStocktakeImportRows,
  type StocktakeImportPreviewRow,
} from "@/lib/warehouse-stocktake-import";

type Option = { id: string; name: string; code?: string };
type CountScope = "ALL" | "DAILY" | "WEEKLY" | "SELECTED";
type SelectionRule =
  | "ALL_ENABLED"
  | "HISTORICAL_MOVEMENT"
  | "PERIOD_MOVEMENT_OR_OPENING"
  | "BOOK_NONZERO_AS_OF"
  | "FIXED_PLAN_PRODUCTS"
  | "MANUAL_SELECTED";
type Plan = {
  id: string;
  no: string;
  name: string;
  warehouseId: string | null;
  countScope: CountScope;
  selectionRule: SelectionRule;
  periodUnit: "DAY" | "WEEK" | "MONTH" | null;
  rowVersion: number;
};
type SelectionPreview = {
  countScope: CountScope;
  selectionRule: SelectionRule;
  periodUnit: "DAY" | "WEEK" | "MONTH" | null;
  selectionFingerprint: string;
  plan: { id: string; no: string; name: string; rowVersion: number } | null;
  products: Array<Product & { reasonCode: string }>;
};
type Product = Option & {
  code: string;
  spec?: string | null;
  category?: string | null;
  inventoryUnit: string | null;
  unit: string;
  unitConversionStatus?: string;
};
type Item = {
  id: string;
  productId: string;
  unitPending?: boolean;
  productNameSnapshot: string;
  productCodeSnapshot: string;
  productSpecSnapshot: string | null;
  storageLocationSnapshot: string | null;
  additionSource: "LEGACY" | "SYSTEM" | "PLAN" | "RECOUNT" | "MANUAL" | "MERGED";
  inventoryUnit: string;
  bookQuantity: string;
  averageUnitCost: string;
  countedQuantity: string | null;
  countedUnitCost: string | null;
  differenceQuantity: string | null;
  differenceValue: string | null;
  reason: string | null;
};
type Section = {
  id: string;
  name: string;
  assignedToId: string;
  status: "OPEN" | "SUBMITTED";
  rowVersion: number;
  submittedAt: string | null;
  items: Item[];
};
type Count = {
  id: string;
  no: string;
  status: string;
  documentType?: "LEGACY" | "MULTI" | "FORMAL";
  postingPolicy?: string;
  postingCycle?: number;
  reviewStatus?: string;
  reviewNote?: string | null;
  rowVersion: number;
  warehouse: Option;
  sections: Section[];
  countDate: string;
  note?: string | null;
  countScope?: CountScope;
  planId?: string | null;
  planNoSnapshot?: string | null;
  planNameSnapshot?: string | null;
  selectionRuleSnapshot?: SelectionRule | null;
  selectionPeriodUnitSnapshot?: "DAY" | "WEEK" | "MONTH" | null;
  selectionFingerprint?: string | null;
  createdBy: Option;
  submittedBy?: Option | null;
  sourceMultiId?: string | null;
  generatedStocktakeId?: string | null;
  mergeSources?: unknown[];
  generatedFrom?: unknown[];
  adjustments: Array<{
    id: string;
    no: string;
    type: "PROFIT" | "LOSS";
    cycle: number;
    status: "POSTED" | "REVERSED";
    totalAmount: string;
  }>;
  countedCount: number;
  itemCount: number;
  totalDifferenceValue: string;
};
type StocktakeLog = { id: string; action: string; actor: string; actorId: string | null; createdAt: string; metadata: unknown };
const additionSourceLabel: Record<Item["additionSource"], string> = {
  LEGACY: "历史数据", SYSTEM: "系统圈定", PLAN: "盘点方案", RECOUNT: "复盘补充", MANUAL: "手工添加", MERGED: "多人汇总",
};
type PendingCreate = {
  body: {
    requestKey: string;
    warehouseId: string;
    countDate: string;
    documentType: "MULTI" | "FORMAL";
    countScope: CountScope;
    planId?: string | null;
    selectionRule: SelectionRule;
    periodUnit?: "DAY" | "WEEK" | "MONTH" | null;
    selectionFingerprint: string;
    sections: DraftSection[];
  };
  countScope: CountScope;
};

function pendingStorageKey(mode: "count" | "multi-count") {
  const tenant = JSON.parse(localStorage.getItem("tenant") || "null");
  const user = getUser();
  if (!tenant?.id || !user?.id)
    throw new Error("缺少当前账号或租户信息，请重新登录");
  return `dj:stocktake-create:${tenant.id}:${user.id}:${mode}`;
}

type DraftSection = {
  name: string;
  assignedToId: string;
  productIds: string[];
};

// The route accepts at most ten integer and six fractional digits. Compare at
// this exact precision so a small difference at large quantities is not lost.
function quantityMicros(value: string, input = false): bigint | null {
  const match = value.match(
    input ? /^(\d{1,10})(?:\.(\d{1,6}))?$/ : /^(\d{1,12})(?:\.(\d{1,6}))?$/
  );
  return match
    ? BigInt(match[1]) * BigInt(1000000) +
        BigInt((match[2] || "").padEnd(6, "0"))
    : null;
}

const labels: Record<string, string> = {
  DRAFT: "草稿",
  COUNTING: "盘点中",
  REVIEWING: "待审核",
  CONFIRMED: "已审核",
  CANCELLED: "已取消",
};
const field = "w-full rounded-lg border border-border bg-white p-2";

export default function WarehouseStocktakeWorkPage() {
  const router = useRouter();
  const user = getUser();
  const canWrite = [
    "SUPPLY_CHAIN",
    "SUPER_ADMIN",
    "ADMIN",
    "PURCHASER",
  ].includes(user?.role || "");
  const canAudit = ["SUPPLY_CHAIN", "SUPER_ADMIN", "ADMIN"].includes(
    user?.role || ""
  );
  const canReadInventoryReports = [
    "SUPPLY_CHAIN",
    "SUPER_ADMIN",
    "ADMIN",
    "FINANCE",
  ].includes(user?.role || "");
  const [options, setOptions] = useState<{
    warehouses: Option[];
    users: Option[];
    products: Product[];
    plans: Plan[];
  }>({ warehouses: [], users: [], products: [], plans: [] });
  const [rows, setRows] = useState<
    Array<{ id: string; no: string; status: string; warehouse: Option }>
  >([]);
  const [count, setCount] = useState<Count | null>(null);
  const [logs, setLogs] = useState<StocktakeLog[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsCursor, setLogsCursor] = useState<string | null>(null);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const logsSequence = useRef(0);
  const currentLogStocktakeId = useRef("");
  const [creating, setCreating] = useState(false);
  const [returnPage, setReturnPage] = useState<"count" | "multi-count">(
    "count"
  );
  const [warehouseId, setWarehouseId] = useState("");
  const [date, setDate] = useState(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  );
  const [countScope, setCountScope] = useState<CountScope>("ALL");
  const [planId, setPlanId] = useState("");
  const [selectionPreview, setSelectionPreview] = useState<SelectionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sections, setSections] = useState<DraftSection[]>([]);
  const [entries, setEntries] = useState<
    Record<
      string,
      { countedQuantity: string; countedUnitCost: string; reason: string }
    >
  >({});
  const [query, setQuery] = useState("");
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerDate, setHeaderDate] = useState("");
  const [headerNote, setHeaderNote] = useState("");
  const [addingItems, setAddingItems] = useState(false);
  const [itemQuery, setItemQuery] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [importPreview, setImportPreview] = useState<{
    sectionId: string;
    fileName: string;
    rows: StocktakeImportPreviewRow[];
    validCount: number;
    errorCount: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const pendingCreate = useRef<PendingCreate | null>(null);
  const pendingCreateSourceKey = useRef<string | null>(null);
  const pendingReverseApproval = useRef<{
    id: string;
    rowVersion: number;
    reason: string;
    requestKey: string;
  } | null>(null);
  const preApprovalRequestKeys = useRef(new Map<string, string>());
  const [resultUnknown, setResultUnknown] = useState(false);
  const [confirm, openConfirm] = useConfirmSheet();
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadSequence = useRef(0);
  const baselineEntries = useRef("");
  const hasUnsavedEntries =
    baselineEntries.current !== "" &&
    JSON.stringify(entries) !== baselineEntries.current;

  function preApprovalRequestKey(
    action: string,
    rowVersion: number,
    payload: unknown
  ) {
    const signature = JSON.stringify({
      id: count?.id,
      action,
      rowVersion,
      payload,
    });
    const existing = preApprovalRequestKeys.current.get(signature);
    if (existing) return existing;
    const requestKey = crypto.randomUUID();
    preApprovalRequestKeys.current.set(signature, requestKey);
    return requestKey;
  }

  function protectChange(proceed: () => void) {
    if (busy || resultUnknown) {
      setError("操作结果尚未确认，请等待或重试原请求后再离开");
      return;
    }
    if (!creating && !hasUnsavedEntries) {
      proceed();
      return;
    }
    openConfirm({
      title: "放弃未保存的盘点填写？",
      body:
        returnPage === "multi-count"
          ? "尚未保存的商品选择或实盘录入将丢失。已保存到服务器的子单保留。"
          : "尚未保存的分区分配或实盘录入将丢失。已保存到服务器的草稿保留。",
      confirmLabel: "放弃并继续",
      tone: "danger",
      onConfirm: proceed,
    });
  }

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!creating && !hasUnsavedEntries && !busy && !resultUnknown) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event: Event) => {
      if (!creating && !hasUnsavedEntries && !busy && !resultUnknown) return;
      event.preventDefault();
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail
        ?.proceed;
      protectChange(() => proceed?.());
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, navigate);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, navigate);
    };
  }, [creating, hasUnsavedEntries, busy, resultUnknown, openConfirm]);

  async function load(id?: string, savedSectionId?: string) {
    currentLogStocktakeId.current = id || "";
    ++logsSequence.current;
    setLogsLoading(false);
    setLogs([]);
    setLogsLoaded(false);
    setLogsCursor(null);
    setLogsHasMore(false);
    const sequence = ++loadSequence.current;
    setDetailLoading(true);
    try {
      const documentType =
        new URLSearchParams(window.location.search).get("from") ===
        "multi-count"
          ? "MULTI"
          : "FORMAL";
      const list = await apiFetch<{ rows: typeof rows }>(
        `/api/warehouse-stocktakes?page=1&pageSize=200&documentType=${documentType}`
      );
      if (sequence !== loadSequence.current) return;
      setRows(list.rows);
      if (!id) return;
      const detail = await apiFetch<Count>(`/api/warehouse-stocktakes/${id}`);
      if (sequence !== loadSequence.current) return;
      if (
        detail.documentType &&
        (documentType === "MULTI"
          ? detail.documentType !== "MULTI"
          : detail.documentType === "MULTI")
      )
        throw new Error("盘点单类型与当前页面不一致，请从正确列表打开");
      setCount(detail);
      setHeaderDate(String(detail.countDate || "").slice(0, 10));
      setHeaderNote(detail.note || "");
      const nextEntries = Object.fromEntries(
        detail.sections.flatMap((section) =>
          section.items.map((item) => [
            item.id,
            {
              countedQuantity: item.countedQuantity ?? "",
              countedUnitCost: item.unitPending
                ? ""
                : item.countedUnitCost ?? item.averageUnitCost,
              reason: item.reason || "",
            },
          ])
        )
      );
      const previousBaseline = JSON.parse(
        baselineEntries.current || "{}"
      ) as typeof entries;
      baselineEntries.current = JSON.stringify(nextEntries);
      setEntries((current) =>
        savedSectionId
          ? Object.fromEntries(
              detail.sections.flatMap((section) =>
                section.items.map((item) => [
                  item.id,
                  section.id !== savedSectionId &&
                  current[item.id] &&
                  JSON.stringify(current[item.id]) !==
                    JSON.stringify(previousBaseline[item.id])
                    ? current[item.id]
                    : nextEntries[item.id],
                ])
              )
            )
          : nextEntries
      );
      return detail;
    } finally {
      if (sequence === loadSequence.current) setDetailLoading(false);
    }
  }

  async function loadLogs(append = false) {
    if (!count || logsLoading) return;
    const requestedId = count.id;
    currentLogStocktakeId.current = requestedId;
    const sequence = ++logsSequence.current;
    setLogsLoading(true);
    try {
      const cursor = append ? logsCursor : null;
      const response = await apiFetch<{ items: StocktakeLog[]; hasMore: boolean; nextCursor: string | null }>(`/api/warehouse-stocktakes/${encodeURIComponent(requestedId)}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (sequence !== logsSequence.current || currentLogStocktakeId.current !== requestedId) return;
      setLogs(current => append ? [...current, ...response.items] : response.items); setLogsLoaded(true);
      setLogsCursor(response.nextCursor); setLogsHasMore(response.hasMore);
    } catch (reason: any) { if (sequence === logsSequence.current) setError(reason.message || "操作日志加载失败"); }
    finally { if (sequence === logsSequence.current) setLogsLoading(false); }
  }

  useEffect(() => {
    let recovering = false;
    try {
      const mode =
        new URLSearchParams(window.location.search).get("from") ===
        "multi-count"
          ? "multi-count"
          : "count";
      const isolatedKey = pendingStorageKey(mode);
      const legacyKey = isolatedKey.replace(`:${mode}`, "");
      const isolatedRaw = sessionStorage.getItem(isolatedKey);
      const legacyRaw = sessionStorage.getItem(legacyKey);
      let raw: string | null = null;
      let sourceKey: string | null = null;
      if (isolatedRaw) {
        raw = isolatedRaw;
        sourceKey = isolatedKey;
      } else if (legacyRaw) {
        const legacyCandidate = JSON.parse(legacyRaw) as PendingCreate;
        const expectedType = mode === "multi-count" ? "MULTI" : "FORMAL";
        if (
          !legacyCandidate.body?.documentType ||
          legacyCandidate.body.documentType === expectedType
        ) {
          raw = legacyRaw;
          sourceKey = legacyKey;
        }
      }
      if (raw && sourceKey) {
        recovering = true;
        const saved: PendingCreate = JSON.parse(raw);
        if (!["MULTI", "FORMAL"].includes(saved.body?.documentType)) {
          saved.body.documentType =
            new URLSearchParams(window.location.search).get("from") ===
            "multi-count"
              ? "MULTI"
              : "FORMAL";
        }
        if (
          typeof saved.body?.requestKey !== "string" ||
          !saved.body.requestKey ||
          typeof saved.body.warehouseId !== "string" ||
          !saved.body.warehouseId ||
          typeof saved.body.countDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(saved.body.countDate) ||
          !Array.isArray(saved.body.sections) ||
          !saved.body.sections.length ||
          saved.body.sections.some(
            (section) =>
              !section ||
              typeof section.name !== "string" ||
              typeof section.assignedToId !== "string" ||
              !Array.isArray(section.productIds) ||
              !section.productIds.length ||
              section.productIds.some((id) => typeof id !== "string" || !id)
          ) ||
          !["ALL", "DAILY", "WEEKLY", "SELECTED"].includes(saved.countScope) ||
          saved.body.countScope !== saved.countScope ||
          ![
            "ALL_ENABLED",
            "HISTORICAL_MOVEMENT",
            "PERIOD_MOVEMENT_OR_OPENING",
            "BOOK_NONZERO_AS_OF",
            "FIXED_PLAN_PRODUCTS",
            "MANUAL_SELECTED",
          ].includes(saved.body.selectionRule) ||
          typeof saved.body.selectionFingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(saved.body.selectionFingerprint) ||
          (saved.body.planId != null && typeof saved.body.planId !== "string") ||
          (saved.body.periodUnit != null && !["DAY", "WEEK", "MONTH"].includes(saved.body.periodUnit))
        )
          throw new Error("恢复记录不完整，请核实已创建盘点后处理");
        pendingCreate.current = saved;
        pendingCreateSourceKey.current = sourceKey;
        setWarehouseId(saved.body.warehouseId);
        setDate(saved.body.countDate);
        setSections(saved.body.sections);
        setCountScope(saved.countScope);
        setPlanId(saved.body.planId || "");
        setCreating(true);
        setResultUnknown(true);
        setError("已恢复上次结果未确认的创建请求，请重试原请求核实结果");
      }
    } catch (reason: any) {
      setCreating(true);
      setResultUnknown(true);
      setError(reason.message || "恢复记录读取失败，请核实创建结果");
    }
    const incoming = new URLSearchParams(window.location.search);
    setReturnPage(
      incoming.get("from") === "multi-count" ? "multi-count" : "count"
    );
    if (incoming.get("create") === "1" && !incoming.get("doc") && !recovering)
      setCreating(true);
    apiFetch<typeof options>("/api/warehouse-stocktakes/options")
      .then((result) => {
        setOptions({ ...result, plans: result.plans || [] });
        if (recovering) return;
        const requested = incoming.get("warehouseId");
        const valid =
          requested &&
          result.warehouses.some((warehouse) => warehouse.id === requested);
        if (requested && !valid) setError("所选仓库已停用或不可用，请重新选择");
        setWarehouseId(
          requested ? (valid ? requested : "") : result.warehouses[0]?.id || ""
        );
        setSections([
          {
            name:
              incoming.get("from") === "multi-count"
                ? "多人盘点子单"
                : "单人盘点",
            assignedToId: user?.id || result.users[0]?.id || "",
            productIds: [],
          },
        ]);
      })
      .catch((reason) => setError(reason.message))
      .finally(() => setOptionsLoading(false));
    void load(recovering ? undefined : incoming.get("doc") || undefined).catch(
      (reason) => setError(reason.message)
    );
  }, []);

  async function run(
    task: () => Promise<unknown>,
    message: string,
    id = count?.id,
    savedSectionId?: string
  ) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    let writeConfirmed = false;
    try {
      await task();
      writeConfirmed = true;
      await load(id, savedSectionId);
      setNotice(message);
      return true;
    } catch (reason: any) {
      setError(
        writeConfirmed
          ? `${message}，但最新状态读取失败，请重新打开单据核对；当前填写已保留。${
              reason.message || ""
            }`
          : reason.message || "操作失败"
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runReverseApproval(reason: string) {
    if (!count || busy) return false;
    const matching = pendingReverseApproval.current;
    const request =
      matching &&
      matching.id === count.id &&
      matching.rowVersion === count.rowVersion &&
      matching.reason === reason
        ? matching
        : {
            id: count.id,
            rowVersion: count.rowVersion,
            reason,
            requestKey: crypto.randomUUID(),
          };
    pendingReverseApproval.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    const body = JSON.stringify({
      reason,
      rowVersion: request.rowVersion,
      requestKey: request.requestKey,
    });
    try {
      await apiFetch(
        `/api/warehouse-stocktakes/${request.id}/reverse-approval`,
        { method: "POST", body }
      );
      await load(request.id);
      pendingReverseApproval.current = null;
      setNotice("反审核成功");
      return true;
    } catch (failure: any) {
      try {
        // Do not infer success from mutable document fields: another operator
        // could have used the same reason. Replaying the exact requestKey is
        // the only deterministic proof that this request committed.
        await apiFetch(
          `/api/warehouse-stocktakes/${request.id}/reverse-approval`,
          { method: "POST", body }
        );
        await load(request.id);
        pendingReverseApproval.current = null;
        setNotice("反审核已成功，已使用原请求编号核对结果");
        return true;
      } catch (replayFailure: any) {
        try {
          await load(request.id);
        } catch {}
        setError(
          `${
            replayFailure.message || failure.message || "反审核失败"
          }；目标状态可能已变化，未把本请求标记为成功。原请求编号已保留`
        );
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function previewDraftSelection() {
    if (!warehouseId) throw new Error("请先选择仓库");
    if (!date) throw new Error("请先选择盘点日期");
    const manualProductIds = sections[0]?.productIds || [];
    if (!planId && countScope === "SELECTED" && !manualProductIds.length)
      throw new Error("请至少选择一个盘点商品");
    setPreviewing(true);
    try {
      const preview = await apiFetch<SelectionPreview>(
        "/api/warehouse-stocktake-selection/preview",
        {
          method: "POST",
          body: JSON.stringify({
            warehouseId,
            countDate: date,
            countScope,
            ...(planId ? { planId } : {}),
            ...(!planId && countScope === "SELECTED"
              ? { manualProductIds }
              : {}),
          }),
        }
      );
      setSelectionPreview(preview);
      setSections((rows) => [
        {
          ...(rows[0] || {
            name: returnPage === "multi-count" ? "多人盘点子单" : "单人盘点",
            assignedToId: user?.id || options.users[0]?.id || "",
          }),
          productIds: preview.products.map((product) => product.id),
        },
      ]);
      return preview;
    } finally {
      setPreviewing(false);
    }
  }

  async function createDraft() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const wasUnknown = resultUnknown;
    let confirmed = false;
    try {
      if (resultUnknown && !pendingCreate.current)
        throw new Error("创建恢复记录不可用，请先核实盘点结果，不能创建新请求");
      if (!pendingCreate.current) {
        const preview = await previewDraftSelection();
        const modeSections = [
          {
            ...(sections[0] || { productIds: [] }),
            name: returnPage === "multi-count" ? "多人盘点子单" : "单人盘点",
            assignedToId: user?.id || options.users[0]?.id || "",
          },
        ];
        const effectiveSections = modeSections.map((section) => ({
          ...section,
          productIds: preview.products.map((product) => product.id),
        }));
        if (
          effectiveSections.some((section) => section.productIds.length === 0)
        )
          throw new Error(
            returnPage === "multi-count"
              ? "请至少选择一个盘点商品"
              : "每个分区至少分配一个商品；不用的分区请移除"
          );
        if (
          effectiveSections.every((section) => section.productIds.length === 0)
        )
          throw new Error("至少选择一个盘点商品");
        const saved: PendingCreate = {
          countScope: preview.countScope,
          body: {
            requestKey: crypto.randomUUID(),
            warehouseId,
            countDate: date,
            documentType: returnPage === "multi-count" ? "MULTI" : "FORMAL",
            countScope: preview.countScope,
            ...(preview.plan ? { planId: preview.plan.id } : {}),
            selectionRule: preview.selectionRule,
            ...(preview.periodUnit ? { periodUnit: preview.periodUnit } : {}),
            selectionFingerprint: preview.selectionFingerprint,
            sections: effectiveSections,
          },
        };
        const isolatedKey = pendingStorageKey(returnPage);
        sessionStorage.setItem(isolatedKey, JSON.stringify(saved));
        pendingCreate.current = saved;
        pendingCreateSourceKey.current = isolatedKey;
      }
      sessionStorage.setItem(
        pendingStorageKey(returnPage),
        JSON.stringify(pendingCreate.current)
      );
      const result = await apiFetch<{ stocktake: Count }>(
        "/api/warehouse-stocktakes",
        {
          method: "POST",
          body: JSON.stringify(pendingCreate.current.body),
        }
      );
      confirmed = true;
      sessionStorage.removeItem(pendingStorageKey(returnPage));
      if (pendingCreateSourceKey.current)
        sessionStorage.removeItem(pendingCreateSourceKey.current);
      pendingCreate.current = null;
      pendingCreateSourceKey.current = null;
      setResultUnknown(false);
      setCreating(false);
      await load(result.stocktake.id);
      setNotice(
        returnPage === "multi-count"
          ? "多人盘点子单已创建，请录入实盘数"
          : "盘点单已创建，请录入实盘数"
      );
    } catch (reason: any) {
      if (confirmed) {
        setError("盘点已创建，但列表加载失败，请刷新页面查看，勿重复创建");
      } else if (pendingCreate.current) {
        if (!wasUnknown && reason.status >= 400 && reason.status < 500) {
          sessionStorage.removeItem(pendingStorageKey(returnPage));
          if (pendingCreateSourceKey.current)
            sessionStorage.removeItem(pendingCreateSourceKey.current);
          pendingCreate.current = null;
          pendingCreateSourceKey.current = null;
          setResultUnknown(false);
          setError(reason.message || "创建请求被拒绝，请修正后再试");
        } else {
          setResultUnknown(true);
          setError(
            `${reason.message || "请求失败"}；创建结果未确认，请重试原请求`
          );
        }
      } else setError(reason.message || "创建盘点失败");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function sectionItemsForWrite(section: Section, submit: boolean) {
    const clearedRecordedItem = section.items.find(
      (item) =>
        !item.unitPending &&
        item.countedQuantity !== null &&
        entries[item.id]?.countedQuantity === ""
    );
    if (clearedRecordedItem) {
      setError(
        `「${clearedRecordedItem.productNameSnapshot}」已有保存的实盘数量，不能清空后保存。请填写实际数量；实盘为零请明确填写0。当前输入已保留，未发送保存或提交。`
      );
      return null;
    }
    if (submit && section.items.some((item) => item.unitPending)) {
      setError(
        returnPage === "multi-count"
          ? "子单存在待核验换算，请先补齐并刷新换算后提交"
          : "分区存在待核验换算，请先补齐并刷新换算后提交"
      );
      return null;
    }
    const invalidQuantity = section.items.find(
      (item) =>
        !item.unitPending &&
        entries[item.id]?.countedQuantity !== "" &&
        quantityMicros(entries[item.id]?.countedQuantity || "", true) === null
    );
    if (invalidQuantity) {
      setError(
        `「${invalidQuantity.productNameSnapshot}」实盘数量格式不正确，请填写非负数，最多10位整数及6位小数`
      );
      return null;
    }
    if (submit) {
      const missingReason = section.items.find(
        (item) =>
          !item.unitPending &&
          entries[item.id]?.countedQuantity !== "" &&
          quantityMicros(entries[item.id]?.countedQuantity || "", true) !==
            quantityMicros(item.bookQuantity) &&
          !entries[item.id]?.reason.trim()
      );
      if (missingReason) {
        setError(
          `「${
            missingReason.productNameSnapshot
          }」存在差异，请填写盘盈/盘亏原因后再${
            returnPage === "multi-count" ? "提交审核" : "提交分区"
          }`
        );
        return null;
      }
    }
    const items = section.items
      .filter(
        (item) => !item.unitPending && entries[item.id]?.countedQuantity !== ""
      )
      .map((item) => ({ itemId: item.id, ...entries[item.id] }));
    if (!items.length) {
      setError("请先录入实盘数量，待核验商品需先补齐换算");
      return null;
    }
    return items;
  }

  function fillEmptyCountedQuantities(
    section: Section,
    source: "BOOK" | "ZERO"
  ) {
    const emptyItems = section.items.filter(
      (item) =>
        !item.unitPending &&
        (entries[item.id]?.countedQuantity ?? "") === ""
    );
    const fillableItems = emptyItems.filter(
      (item) =>
        source === "ZERO" || quantityMicros(item.bookQuantity, true) !== null
    );
    if (!fillableItems.length) {
      setNotice("");
      setError(
        emptyItems.length
          ? "空白项的账面数量超出实盘输入范围，请逐项核对后填写"
          : "当前没有可批量填充的空白实盘项"
      );
      return;
    }
    setEntries((current) => {
      const next = { ...current };
      for (const item of fillableItems) {
        next[item.id] = {
          ...next[item.id],
          countedQuantity: source === "BOOK" ? item.bookQuantity : "0",
        };
      }
      return next;
    });
    setNotice(
      `已为 ${fillableItems.length} 个空白项${
        source === "BOOK" ? "填入账面数量" : "填入 0"
      }，已有实盘值未覆盖`
    );
    setError(
      fillableItems.length < emptyItems.length
        ? "部分账面数量超出实盘输入范围，已跳过，请逐项核对"
        : ""
    );
  }

  async function downloadImportTemplate(section: Section) {
    const XLSX = await import("xlsx");
    const worksheet = XLSX.utils.json_to_sheet(
      section.items.map((item) => ({
        物品编码: item.productCodeSnapshot,
        物品名称: item.productNameSnapshot,
        库存单位: item.inventoryUnit,
        账面数量: item.bookQuantity,
        实盘数量: "",
        差异说明: "",
      }))
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "盘点结果");
    XLSX.writeFile(workbook, `盘点结果导入模板-${count?.no || "盘点单"}.xlsx`);
  }

  async function previewImportFile(section: Section, file: File) {
    setError("");
    setNotice("");
    if (file.size > 5 * 1024 * 1024) {
      setError("导入文件不能超过5MB");
      return;
    }
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("导入文件没有工作表");
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
        workbook.Sheets[sheetName],
        { defval: "" }
      );
      if (rawRows.length > 3000) throw new Error("单次最多导入3000行");
      const preview = previewWarehouseStocktakeImportRows(rawRows, section.items);
      if (!preview.rows.length) throw new Error("没有读取到盘点结果，请核对表头和内容");
      setImportPreview({ sectionId: section.id, fileName: file.name, ...preview });
    } catch (reason: any) {
      setImportPreview(null);
      setError(reason.message || "盘点结果文件解析失败");
    } finally {
      setBusy(false);
    }
  }

  function applyImportPreview() {
    if (!importPreview || importPreview.errorCount) return;
    setEntries((current) => {
      const next = { ...current };
      for (const row of importPreview.rows) {
        if (!row.itemId) continue;
        next[row.itemId] = {
          ...next[row.itemId],
          countedQuantity: row.countedQuantity,
          reason: row.reason,
        };
      }
      return next;
    });
    setNotice(
      `已应用 ${importPreview.validCount} 行导入结果，尚未保存，请核对后保存或提交`
    );
    setImportPreview(null);
  }

  async function saveSection(section: Section, submit: boolean) {
    const items = sectionItemsForWrite(section, submit);
    if (!items) return;
    await run(
      () =>
        apiFetch(
          `/api/warehouse-stocktakes/${count!.id}/sections/${section.id}`,
          {
            method: "PUT",
            body: JSON.stringify({
              rowVersion: section.rowVersion,
              submit,
              items,
            }),
          }
        ),
      `${returnPage === "multi-count" ? "子单" : section.name}${
        submit ? "已提交" : "已保存"
      }`,
      count!.id,
      section.id
    );
  }

  async function runPreApprovalMutation(
    task: () => Promise<unknown>,
    message: string,
    onSuccess: () => void
  ) {
    if (!count || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    let writeConfirmed = false;
    try {
      await task();
      writeConfirmed = true;
      await load(count.id);
      onSuccess();
      setNotice(message);
      return true;
    } catch (reason: any) {
      setError(
        writeConfirmed
          ? `${message}，但最新状态读取失败；当前输入和原请求编号已保留，请重试核对。${
              reason.message || ""
            }`
          : reason.message || "操作失败，当前输入已保留"
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveHeader() {
    if (!count) return;
    if (hasUnsavedEntries) {
      setError("请先保存盘点明细，再修改表头；当前输入已保留");
      return;
    }
    const payload = { countDate: headerDate, note: headerNote.trim() || null };
    if (!headerDate) {
      setError("请选择盘点日期");
      return;
    }
    const body = {
      ...payload,
      rowVersion: count.rowVersion,
      requestKey: preApprovalRequestKey(
        "HEADER_EDIT",
        count.rowVersion,
        payload
      ),
    };
    await runPreApprovalMutation(
      () =>
        apiFetch(`/api/warehouse-stocktakes/${count.id}/header`, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      "盘点表头已保存",
      () => setEditingHeader(false)
    );
  }

  async function addSelectedItems() {
    if (!count || !selectedProductIds.length) {
      setError("请选择要添加的商品");
      return;
    }
    if (hasUnsavedEntries) {
      setError("请先保存盘点明细，再添加商品；当前输入已保留");
      return;
    }
    const section = count.sections.find((row) => row.status === "OPEN");
    if (!section) {
      setError("没有可编辑的盘点分区");
      return;
    }
    const payload = { sectionId: section.id, productIds: selectedProductIds };
    const body = {
      ...payload,
      rowVersion: count.rowVersion,
      requestKey: preApprovalRequestKey("ITEM_ADD", count.rowVersion, payload),
    };
    await runPreApprovalMutation(
      () =>
        apiFetch(`/api/warehouse-stocktakes/${count.id}/items`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      `已添加 ${selectedProductIds.length} 个盘点商品`,
      () => {
        setAddingItems(false);
        setSelectedProductIds([]);
        setItemQuery("");
      }
    );
  }

  async function moveStocktakeItem(
    section: Section,
    itemId: string,
    direction: -1 | 1
  ) {
    if (!count) return;
    if (hasUnsavedEntries) {
      setError("请先保存盘点明细，再调整商品顺序；当前输入已保留");
      return;
    }
    const currentIndex = section.items.findIndex((item) => item.id === itemId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= section.items.length)
      return;
    const itemIds = section.items.map((item) => item.id);
    [itemIds[currentIndex], itemIds[nextIndex]] = [
      itemIds[nextIndex],
      itemIds[currentIndex],
    ];
    const payload = { sectionId: section.id, itemIds };
    const body = {
      ...payload,
      rowVersion: count.rowVersion,
      requestKey: preApprovalRequestKey(
        "ITEM_REORDER",
        count.rowVersion,
        payload
      ),
    };
    await runPreApprovalMutation(
      () =>
        apiFetch(`/api/warehouse-stocktakes/${count.id}/items/reorder`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      "商品顺序已保存",
      () => undefined
    );
  }

  function confirmRemoveItem(item: Item) {
    if (!count) return;
    if (hasUnsavedEntries) {
      setError("请先保存盘点明细，再移除商品；当前输入已保留");
      return;
    }
    openConfirm({
      title: "移除盘点商品",
      body: `确认移除「${item.productNameSnapshot}」？该商品已保存的实盘录入也会一并移除。`,
      confirmLabel: "移除",
      tone: "danger",
      onConfirm: async () => {
        const payload = { itemIds: [item.id] };
        const body = {
          ...payload,
          rowVersion: count.rowVersion,
          requestKey: preApprovalRequestKey(
            "ITEM_REMOVE",
            count.rowVersion,
            payload
          ),
        };
        if (
          !(await runPreApprovalMutation(
            () =>
              apiFetch(`/api/warehouse-stocktakes/${count.id}/items/remove`, {
                method: "POST",
                body: JSON.stringify(body),
              }),
            `已移除「${item.productNameSnapshot}」`,
            () => undefined
          ))
        )
          throw new Error("移除未完成，当前输入已保留");
      },
    });
  }

  function confirmMultiSubmit(section: Section) {
    if (!count || busy) return;
    const items =
      section.status === "SUBMITTED" ? [] : sectionItemsForWrite(section, true);
    if (!items) return;
    openConfirm({
      title: "提交审核",
      body: "提交后将锁定这张独立子单的实盘内容，并进入待审核状态。",
      confirmLabel: "提交审核",
      onConfirm: async () => {
        setBusy(true);
        setError("");
        setNotice("");
        let sectionSubmitted = section.status === "SUBMITTED";
        let stocktakeSubmitted = false;
        try {
          let rowVersion = count.rowVersion;
          if (!sectionSubmitted) {
            const saved = await apiFetch<Count>(
              `/api/warehouse-stocktakes/${count.id}/sections/${section.id}`,
              {
                method: "PUT",
                body: JSON.stringify({
                  rowVersion: section.rowVersion,
                  submit: true,
                  items,
                }),
              }
            );
            sectionSubmitted = true;
            rowVersion = saved.rowVersion;
          }
          await apiFetch(`/api/warehouse-stocktakes/${count.id}/submit`, {
            method: "POST",
            body: JSON.stringify({ rowVersion }),
          });
          stocktakeSubmitted = true;
          await load(count.id);
          setNotice("多人盘点子单已提交审核");
        } catch (reason: any) {
          // PUT 可能已提交成功但响应在网络中丢失。无条件重新读取服务端
          // 状态，才能让已锁定的子单直接续提 POST /submit，而不是用旧版本重写。
          try {
            await load(count.id);
          } catch {}
          const detail = reason.message || "操作失败";
          if (stocktakeSubmitted)
            setError(
              `子单已提交审核，但最新状态读取失败，请重新打开单据核对。${detail}`
            );
          else if (sectionSubmitted)
            setError(
              `子单实盘内容已保存并锁定，但进入待审核状态失败；请点击“提交审核”继续，不要重新录入。${detail}`
            );
          else setError(detail);
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function confirmTransition(
    action:
      | "submit"
      | "withdraw"
      | "approve"
      | "final-review"
      | "reject"
      | "reverse-approval"
      | "cancel"
  ) {
    if (!count) return;
    if (hasUnsavedEntries && action !== "cancel") {
      setError(
        returnPage === "multi-count"
          ? "请先保存子单中未保存的实盘录入，再执行单据操作"
          : "请先保存各分区未保存的实盘录入，再执行单据操作"
      );
      return;
    }
    const title = {
      submit: "汇总提交审核",
      withdraw: "撤回继续录入",
      approve: "审核",
      "final-review": "复盘审核",
      reject: "驳回继续录入",
      "reverse-approval": "反审核",
      cancel: "取消盘点单",
    }[action];
    openConfirm({
      title,
      body:
        action === "final-review"
          ? "复审会锁定已审核盘点单，不会重复调整库存。"
          : action === "approve"
          ? returnPage === "multi-count"
            ? "审核完成后可以生成一张独立的正式盘点单；这张多人盘点单不直接改变库存和金额。"
            : "审核后立即按实盘数调整库存并生成盘盈/盘亏单；复审后锁定。"
          : action === "withdraw"
          ? "撤回后单据和分区会恢复为录入中，已保存的实盘内容保留。"
          : action === "reject"
          ? "驳回后单据和分区会恢复为录入中，已保存的实盘内容保留。"
          : action === "reverse-approval"
          ? "反审核会追加冲销流水并恢复审核前库存；原盘盈/盘亏单、原流水和批次记录都会保留。审核后若已有出入库、预占或批次使用，系统将拒绝整单操作。"
          : returnPage === "multi-count"
          ? "请确认已核对这张独立子单。"
          : "请确认已核对单据和各分区进度。",
      tone: ["cancel", "reverse-approval"].includes(action)
        ? "danger"
        : "primary",
      withInput: ["reject", "reverse-approval", "cancel"].includes(action),
      inputRequired: ["reject", "reverse-approval", "cancel"].includes(action),
      inputPlaceholder:
        action === "reject"
          ? "请填写退回原因"
          : action === "reverse-approval"
          ? "请填写反审核原因"
          : action === "cancel"
          ? "请填写取消原因"
          : undefined,
      onConfirm: async (inputReason) => {
        const reason = inputReason?.trim() || "";
        if (
          ["reject", "reverse-approval", "cancel"].includes(action) &&
          (!reason || reason.length < 2)
        )
          throw new Error("请填写至少2个字的原因");
        if (action === "reverse-approval") {
          if (!(await runReverseApproval(reason)))
            throw new Error("操作未完成");
          return;
        }
        if (action === "withdraw" || action === "reject") {
          const payload = action === "reject" ? { reason } : {};
          const body = {
            ...payload,
            rowVersion: count.rowVersion,
            requestKey: preApprovalRequestKey(
              action.toUpperCase(),
              count.rowVersion,
              payload
            ),
          };
          if (
            !(await runPreApprovalMutation(
              () =>
                apiFetch(`/api/warehouse-stocktakes/${count.id}/${action}`, {
                  method: "POST",
                  body: JSON.stringify(body),
                }),
              `${title}成功`,
              () => undefined
            ))
          )
            throw new Error("操作未完成，当前输入和原请求编号已保留");
          return;
        }
        const body =
          action === "submit"
            ? { rowVersion: count.rowVersion }
            : action === "cancel"
            ? { reason, rowVersion: count.rowVersion }
            : undefined;
        if (
          !(await run(
            () =>
              apiFetch(`/api/warehouse-stocktakes/${count.id}/${action}`, {
                method: "POST",
                ...(body ? { body: JSON.stringify(body) } : {}),
              }),
            `${title}成功`
          ))
        )
          throw new Error("操作未完成");
      },
    });
  }

  const hasGeneratedOrMergedRelation = Boolean(
    count?.sourceMultiId ||
      count?.generatedStocktakeId ||
      count?.mergeSources?.length ||
      count?.generatedFrom?.length
  );
  const creatorOrAdmin = Boolean(
    count &&
      (count.createdBy?.id === user?.id ||
        ["ADMIN", "SUPER_ADMIN"].includes(user?.role || ""))
  );
  const canEditStructure = Boolean(
    count &&
      canWrite &&
      creatorOrAdmin &&
      ["DRAFT", "COUNTING"].includes(count.status) &&
      !hasGeneratedOrMergedRelation &&
      !(count.postingCycle || 0)
  );
  const hasFrozenSelection = Boolean(
    count?.planId ||
      (count?.countScope && count.countScope !== "SELECTED") ||
      (count?.selectionRuleSnapshot &&
        count.selectionRuleSnapshot !== "MANUAL_SELECTED")
  );
  const canEditItems = Boolean(
    canEditStructure &&
      !hasFrozenSelection &&
      count?.sections.some((section) => section.status === "OPEN")
  );
  const canReorderItems = Boolean(
    canEditStructure &&
      count?.sections.some(
        (section) => section.status === "OPEN" && section.items.length > 1
      )
  );
  const existingProductIds = new Set(
    count?.sections.flatMap((section) =>
      section.items.map((item) => item.productId)
    ) || []
  );
  const availableProducts = options.products.filter(
    (product) =>
      !existingProductIds.has(product.id) &&
      `${product.code} ${product.name}`
        .toLowerCase()
        .includes(itemQuery.trim().toLowerCase())
  );

  return (
    <main className={`${sheet.page} ${sheet.workPage}`}>
      <header className={sheet.header}>
        {canReadInventoryReports && (
          <Link
            href={`/v2/supply-chain/stocktake/${returnPage}`}
            onClick={(event) => {
              if (event.defaultPrevented) return;
              event.preventDefault();
              protectChange(() =>
                router.push(`/v2/supply-chain/stocktake/${returnPage}`)
              );
            }}
            className="text-caption underline"
          >
            {returnPage === "multi-count" ? "返回多人盘点查询" : "返回盘点查询"}
          </Link>
        )}
        <h1>{returnPage === "multi-count" ? "多人盘点子单" : "盘点单作业"}</h1>
      </header>
      <p className="text-caption text-gray2">
        {returnPage === "multi-count"
          ? "每人建立并完成自己的独立子单；审核后在列表勾选同日期、同仓库子单合并生成正式盘点单。"
          : "单人录入 → 提交 → 审核即调整库存 → 复审锁定。"}{" "}
        库存已变化时，需要取消旧单并重新盘点。
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">
          {error}
        </p>
      )}
      {count && error.includes("库存已变动") && (
        <aside className="border border-amber-200 bg-amber-50 p-3">
          <strong>这张单的库存快照已过期</strong>
          <p>
            只退回重填不会更新旧账面。请先退回录入，再取消旧单，最后在同一仓库新建盘点。旧单和操作记录会保留。
          </p>
        </aside>
      )}
      {notice && (
        <p role="status" className="rounded-xl bg-green-50 p-3">
          {notice}
        </p>
      )}
      {canWrite && (
        <button
          className="w-fit rounded border border-border px-3 py-1.5"
          disabled={busy || resultUnknown || optionsLoading}
          onClick={() => {
            if (creating)
              protectChange(() => {
                setCreating(false);
                setSections([
                  {
                    name:
                      returnPage === "multi-count"
                        ? "多人盘点子单"
                        : "单人盘点",
                    assignedToId: user?.id || options.users[0]?.id || "",
                    productIds: [],
                  },
                ]);
                setQuery("");
              });
            else
              protectChange(() => {
                setWarehouseId(count?.warehouse.id || warehouseId);
                setCreating(true);
              });
          }}
        >
          新建{returnPage === "multi-count" ? "多人盘点子单" : "盘点单"}
        </button>
      )}
      {creating && (
        <section className="space-y-3 border border-border p-3">
          <h2 className="text-h2">
            创建{returnPage === "multi-count" ? "多人盘点子单" : "盘点单"}
          </h2>
          <fieldset disabled={busy || resultUnknown} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                仓库
                <SearchableSelect
                  searchWhenLong
                  searchLabel="搜索仓库"
                  className={field}
                  value={warehouseId}
                  onChange={(event) => {
                    setWarehouseId(event.target.value);
                    setPlanId("");
                    setSelectionPreview(null);
                  }}
                >
                  <option value="">请选择仓库</option>
                  {options.warehouses.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </SearchableSelect>
              </label>
              <label>
                盘点日期
                <input
                  className={field}
                  type="date"
                  value={date}
                  min={date}
                  max={date}
                  readOnly
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label>
                盘点方案（可选）
                <SearchableSelect
                  searchWhenLong
                  searchLabel="搜索盘点方案"
                  className={field}
                  value={planId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const plan = options.plans.find((row) => row.id === nextId);
                    setPlanId(nextId);
                    if (plan) setCountScope(plan.countScope);
                    setSelectionPreview(null);
                  }}
                >
                  <option value="">不使用方案</option>
                  {options.plans
                    .filter((plan) => !plan.warehouseId || plan.warehouseId === warehouseId)
                    .map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.no} · {plan.name}
                      </option>
                    ))}
                </SearchableSelect>
              </label>
              {canAudit && <Link className="text-caption underline" href="/v2/supply-chain/stocktake/plans">管理盘点方案</Link>}
            </div>
            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-caption text-gray2">盘点范围</legend>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="countScope"
                    checked={countScope === "ALL"}
                    onChange={() => { setPlanId(""); setCountScope("ALL"); setSelectionPreview(null); }}
                  />
                  全部盘点
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="countScope"
                    checked={countScope === "DAILY"}
                    onChange={() => { setPlanId(""); setCountScope("DAILY"); setSelectionPreview(null); }}
                  />
                  日盘
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="countScope"
                    checked={countScope === "WEEKLY"}
                    onChange={() => { setPlanId(""); setCountScope("WEEKLY"); setSelectionPreview(null); }}
                  />
                  周盘
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="countScope"
                    checked={countScope === "SELECTED"}
                    onChange={() => { setPlanId(""); setCountScope("SELECTED"); setSelectionPreview(null); }}
                  />
                  指定盘点
                </label>
              </div>
              <p className="mt-2 text-caption text-gray3">
                {countScope === "ALL"
                  ? `盘点该仓库当前全部 ${options.products.length} 个商品；创建前由服务器重新圈定。`
                  : countScope === "DAILY"
                  ? "圈定今日期初不为零或发生实物库存变动的商品。"
                  : countScope === "WEEKLY"
                  ? "圈定本周期初不为零或发生实物库存变动的商品。"
                  : planId
                  ? "按所选方案的固定商品或历史规则圈定。"
                  : "按分类全选或逐个选择本次要盘点的商品。"}
              </p>
            </fieldset>
            {countScope === "SELECTED" && !planId && <>
              <label className="block">
                筛选商品
                <input
                  className={field}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="商品名称 / 编码"
                />
              </label>
            </>}
            {countScope === "SELECTED" && !planId &&
            sections.slice(0, 1).map((section, index) => (
              <div key={index} className="rounded-lg border p-3">
                <p className="mt-2 text-caption">
                  已选择 {section.productIds.length} 项
                  {returnPage === "multi-count"
                    ? "，这是一张由当前创建人录入的独立子单。"
                    : "；负责人为当前创建人。"}
                </p>
                <div className="mt-2 max-h-72 space-y-3 overflow-auto">
                  {Array.from(
                    new Set(
                      options.products.map(
                        (product) => product.category || "未分类"
                      )
                    )
                  ).map((category) => {
                    const categoryProducts = options.products.filter(
                      (product) =>
                        (product.category || "未分类") === category &&
                        `${product.code} ${product.name}`
                          .toLowerCase()
                          .includes(query.toLowerCase())
                    );
                    if (!categoryProducts.length) return null;
                    const availableIds = categoryProducts.map(
                      (product) => product.id
                    );
                    const allSelected = availableIds.every((id) =>
                      section.productIds.includes(id)
                    );
                    return (
                      <div key={category} className="rounded-lg bg-bg p-2">
                        <label className="flex items-center gap-2 font-medium">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={(event) => {
                              setSelectionPreview(null);
                              setSections((rows) =>
                                rows.map((row, i) =>
                                  i === 0
                                    ? {
                                        ...row,
                                        productIds: event.target.checked
                                          ? Array.from(
                                              new Set([
                                                ...row.productIds,
                                                ...availableIds,
                                              ])
                                            )
                                          : row.productIds.filter(
                                              (id) => !availableIds.includes(id)
                                            ),
                                      }
                                    : row
                                )
                              );
                            }}
                          />
                          {query.trim() ? "全选搜索结果" : "全选分类"}：
                          {category}
                        </label>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {categoryProducts.map((product) => (
                            <label key={product.id} className="text-caption">
                              <input
                                type="checkbox"
                                checked={section.productIds.includes(
                                  product.id
                                )}
                                onChange={(event) => {
                                  setSelectionPreview(null);
                                  setSections((rows) =>
                                    rows.map((row, i) =>
                                      i === 0
                                        ? {
                                            ...row,
                                            productIds: event.target.checked
                                              ? [...row.productIds, product.id]
                                              : row.productIds.filter(
                                                  (id) => id !== product.id
                                                ),
                                          }
                                        : row
                                    )
                                  );
                                }}
                              />{" "}
                              {product.code} {product.name}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy || previewing || resultUnknown}
                className="rounded border border-border px-3 py-1.5"
                onClick={() => {
                  setError("");
                  void previewDraftSelection().catch((reason) => setError(reason.message || "圈定预览失败"));
                }}
              >
                {previewing ? "正在圈定…" : "预览圈定结果"}
              </button>
              {selectionPreview && <span className="text-caption">已圈定 {selectionPreview.products.length} 项 · {selectionPreview.plan?.name || selectionPreview.selectionRule}</span>}
            </div>
          </fieldset>
          <button
            disabled={busy || previewing}
            className="rounded-lg bg-ink px-4 py-2 text-white"
            onClick={() => void createDraft()}
          >
            {resultUnknown
              ? "重试原创建请求"
              : returnPage === "multi-count"
              ? "保存子单草稿"
              : "保存盘点草稿"}
          </button>
        </section>
      )}
      <label className="block">
        选择盘点单
        <SearchableSelect
          searchWhenLong
          searchLabel="搜索盘点单"
          className={field}
          value={count?.id || ""}
          disabled={busy || resultUnknown}
          onChange={(event) => {
            const id = event.target.value;
            protectChange(() => {
              setCreating(false);
              if (id) void load(id).catch((reason) => setError(reason.message));
              else {
                ++loadSequence.current;
                setCount(null);
                setEntries({});
                baselineEntries.current = "";
              }
            });
          }}
        >
          <option value="">请选择</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.no} · {row.warehouse.name} · {labels[row.status]}
            </option>
          ))}
        </SearchableSelect>
      </label>
      {count && (
        <section className="space-y-4">
          {count.sections.some((section) =>
            section.items.some((item) => item.unitPending)
          ) && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
              <p>
                有商品换算待核验，
                {returnPage === "multi-count" ? "子单" : "分区"}
                草稿已保存；补齐并核验后才能录入和提交。
              </p>
              <Link
                className="mr-4 underline"
                href="/v2/supply-chain/products"
                onClick={(event) => {
                  if (event.defaultPrevented) return;
                  event.preventDefault();
                  protectChange(() => router.push("/v2/supply-chain/products"));
                }}
              >
                前往商品管理补齐换算
              </Link>
              {canWrite && ["DRAFT", "COUNTING"].includes(count.status) && (
                <button
                  disabled={busy}
                  className="underline"
                  onClick={() =>
                    openConfirm({
                      title: "刷新已核验换算",
                      body:
                        returnPage === "multi-count"
                          ? "请先保存已录入的子单。刷新会重新加载服务器草稿，未保存的录入不会保留。"
                          : "请先保存已录入的分区。刷新会重新加载服务器草稿，未保存的录入不会保留。",
                      onConfirm: async () => {
                        if (
                          !(await run(
                            () =>
                              apiFetch(
                                `/api/warehouse-stocktakes/${count.id}/refresh-units`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    rowVersion: count.rowVersion,
                                  }),
                                }
                              ),
                            "换算已核验，盘点草稿已更新"
                          ))
                        )
                          throw new Error("换算刷新未完成");
                      },
                    })
                  }
                >
                  补齐后刷新换算
                </button>
              )}
            </div>
          )}
          <div className={sheet.meta}>
            <h2 className="text-body font-semibold">
              {count.no} ·{" "}
              {count.reviewStatus === "REVIEWED"
                ? "已复审"
                : labels[count.status]}
            </h2>
            <p>
              {count.warehouse.name} · 已盘 {count.countedCount}/
              {count.itemCount} 项 ·{" "}
              {returnPage === "multi-count" ? "差异金额" : "汇总差异金额"} ¥
              {Number(count.totalDifferenceValue).toFixed(2)}
            </p>
            <p className="text-caption text-gray2">
              盘点日期 {String(count.countDate).slice(0, 10)} · 备注：
              {count.note || "无"}
            </p>
            {(count.planNameSnapshot || count.selectionRuleSnapshot) && (
              <p className="text-caption text-gray2">
                圈定来源：{count.planNameSnapshot || count.selectionRuleSnapshot}
                {count.selectionPeriodUnitSnapshot ? ` · ${count.selectionPeriodUnitSnapshot}` : ""}
              </p>
            )}
            {editingHeader && (
              <div className="grid gap-3 rounded-lg border border-border bg-white p-3 sm:grid-cols-2">
                <label>
                  盘点日期
                  <input
                    aria-label="编辑盘点日期"
                    className={field}
                    type="date"
                    value={headerDate}
                    readOnly
                    aria-readonly="true"
                  />
                </label>
                <label>
                  备注
                  <input
                    aria-label="编辑盘点备注"
                    className={field}
                    value={headerNote}
                    onChange={(event) => setHeaderNote(event.target.value)}
                    maxLength={500}
                  />
                </label>
                <div className={sheet.toolbar}>
                  <button
                    disabled={busy || detailLoading}
                    className="rounded bg-ink px-3 py-1.5 text-white"
                    onClick={() => void saveHeader()}
                  >
                    保存表头
                  </button>
                  <button
                    disabled={busy}
                    className="rounded border px-3 py-1.5"
                    onClick={() => {
                      setHeaderDate(String(count.countDate).slice(0, 10));
                      setHeaderNote(count.note || "");
                      setEditingHeader(false);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {addingItems && (
              <div className="space-y-3 rounded-lg border border-border bg-white p-3">
                <label>
                  搜索待添加商品
                  <input
                    aria-label="搜索待添加商品"
                    className={field}
                    value={itemQuery}
                    onChange={(event) => setItemQuery(event.target.value)}
                    placeholder="商品名称 / 编码"
                  />
                </label>
                <div className="max-h-56 space-y-2 overflow-auto">
                  {availableProducts.map((product) => (
                    <label key={product.id} className="block text-caption">
                      <input
                        type="checkbox"
                        aria-label={`添加商品 ${product.name}`}
                        checked={selectedProductIds.includes(product.id)}
                        onChange={(event) =>
                          setSelectedProductIds((ids) =>
                            event.target.checked
                              ? [...ids, product.id]
                              : ids.filter((id) => id !== product.id)
                          )
                        }
                      />{" "}
                      {product.code} {product.name}
                    </label>
                  ))}
                  {!availableProducts.length && (
                    <p className="text-caption text-gray3">没有可添加商品</p>
                  )}
                </div>
                <div className={sheet.toolbar}>
                  <button
                    disabled={busy || !selectedProductIds.length}
                    className="rounded bg-ink px-3 py-1.5 text-white"
                    onClick={() => void addSelectedItems()}
                  >
                    添加所选商品
                  </button>
                  <button
                    disabled={busy}
                    className="rounded border px-3 py-1.5"
                    onClick={() => setAddingItems(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            <Link
              className="text-caption underline"
              href={`/v2/supply-chain/stocktake/count/${count.id}?source=warehouse`}
              onClick={(event) => {
                if (event.defaultPrevented) return;
                event.preventDefault();
                protectChange(() =>
                  router.push(
                    `/v2/supply-chain/stocktake/count/${count.id}?source=warehouse`
                  )
                );
              }}
            >
              查看差异 / 打印 / 保存 PDF
            </Link>
            <div className={sheet.toolbar}>
              {canEditStructure && !editingHeader && (
                <button
                  disabled={busy || detailLoading}
                  onClick={() => setEditingHeader(true)}
                >
                  编辑表头
                </button>
              )}
              {canEditItems && !addingItems && (
                <button
                  disabled={busy || detailLoading}
                  onClick={() => setAddingItems(true)}
                >
                  添加商品
                </button>
              )}
              {returnPage === "count" &&
                canWrite &&
                ["DRAFT", "COUNTING"].includes(count.status) && (
                  <button
                    disabled={busy}
                    onClick={() => confirmTransition("submit")}
                  >
                    汇总提交审核
                  </button>
                )}
              {canAudit && count.status === "REVIEWING" && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => confirmTransition("approve")}
                  >
                    审核
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => confirmTransition("reject")}
                  >
                    驳回录入
                  </button>
                </>
              )}
              {canWrite &&
                count.status === "REVIEWING" &&
                count.submittedBy?.id === user?.id && (
                  <button
                    disabled={busy}
                    onClick={() => confirmTransition("withdraw")}
                  >
                    撤回录入
                  </button>
                )}
              {returnPage === "count" &&
                canAudit &&
                count.status === "CONFIRMED" &&
                count.reviewStatus !== "REVIEWED" && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => confirmTransition("final-review")}
                    >
                      复盘审核
                    </button>
                    {count.postingPolicy === "REVIEW" && (
                      <button
                        disabled={busy}
                        onClick={() => confirmTransition("reverse-approval")}
                      >
                        反审核
                      </button>
                    )}
                  </>
                )}
              {canWrite && ["DRAFT", "COUNTING"].includes(count.status) && (
                <button
                  disabled={busy}
                  onClick={() => confirmTransition("cancel")}
                >
                  取消盘点
                </button>
              )}
            </div>
          </div>
          {count.sections.map((section) => {
            const editable =
              canWrite &&
              section.assignedToId === user?.id &&
              ["DRAFT", "COUNTING"].includes(count.status) &&
              section.status === "OPEN";
            return (
              <section
                key={section.id}
                className={sheet.workSection}
                aria-label={
                  returnPage === "multi-count"
                    ? "子单盘点明细"
                    : `${section.name}盘点明细`
                }
              >
                <div className={sheet.toolbar}>
                  <h3 className="font-semibold">
                    {returnPage === "multi-count"
                      ? "盘点明细"
                      : `${section.name} · ${
                          options.users.find(
                            (option) => option.id === section.assignedToId
                          )?.name || "负责人"
                        } · ${
                          section.status === "SUBMITTED" ? "已提交" : "录入中"
                        }`}
                  </h3>
                  <span>共 {section.items.length} 项</span>
                </div>
                <div className={sheet.tableWrap}>
                  <table aria-label={`${section.name}商品表格`}>
                    <thead>
                      <tr>
                        {[
                          "序号",
                          "物品编码",
                          "物品名称",
                          "规格型号",
                          "库位",
                          "添加方式",
                          "单位",
                          "账面数量",
                          "实盘数量",
                          "成本单价",
                          "差异数量",
                          "差异金额",
                          "差异说明",
                          "操作",
                        ].map((label) => (
                          <th key={label}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.items.map((item, index) => (
                        <tr key={item.id}>
                          <td>{index + 1}</td>
                          <td>{item.productCodeSnapshot}</td>
                          <td>
                            {item.productNameSnapshot}
                            {item.unitPending && (
                              <small className="block text-orange-700">
                                换算待核验，账面和成本待确认
                              </small>
                            )}
                          </td>
                          <td>{item.productSpecSnapshot || "—"}</td>
                          <td>{item.storageLocationSnapshot || "—"}</td>
                          <td>{additionSourceLabel[item.additionSource] || item.additionSource}</td>
                          <td>{item.inventoryUnit}</td>
                          <td>
                            {item.unitPending ? "待核验" : item.bookQuantity}
                          </td>
                          <td>
                            <input
                              aria-label={`${item.productNameSnapshot}实盘数量`}
                              className={field}
                              type="number"
                              min="0"
                              step="0.000001"
                              disabled={
                                !editable ||
                                busy ||
                                detailLoading ||
                                item.unitPending
                              }
                              value={entries[item.id]?.countedQuantity ?? ""}
                              onChange={(event) =>
                                setEntries((rows) => ({
                                  ...rows,
                                  [item.id]: {
                                    ...rows[item.id],
                                    countedQuantity: event.target.value,
                                  },
                                }))
                              }
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`${item.productNameSnapshot}成本单价`}
                              className={field}
                              type="number"
                              min="0"
                              step="0.000001"
                              disabled={
                                !editable ||
                                busy ||
                                detailLoading ||
                                item.unitPending ||
                                Number(item.averageUnitCost) > 0
                              }
                              value={entries[item.id]?.countedUnitCost ?? ""}
                              onChange={(event) =>
                                setEntries((rows) => ({
                                  ...rows,
                                  [item.id]: {
                                    ...rows[item.id],
                                    countedUnitCost: event.target.value,
                                  },
                                }))
                              }
                            />
                          </td>
                          <td>
                            {item.unitPending
                              ? "待核验"
                              : item.differenceQuantity ?? "未盘"}
                          </td>
                          <td>
                            {item.unitPending
                              ? "待核验"
                              : item.differenceValue ?? "—"}
                          </td>
                          <td>
                            <input
                              aria-label={`${item.productNameSnapshot}差异说明`}
                              className={field}
                              disabled={
                                !editable ||
                                busy ||
                                detailLoading ||
                                item.unitPending
                              }
                              value={entries[item.id]?.reason ?? ""}
                              onChange={(event) =>
                                setEntries((rows) => ({
                                  ...rows,
                                  [item.id]: {
                                    ...rows[item.id],
                                    reason: event.target.value,
                                  },
                                }))
                              }
                            />
                          </td>
                          <td>
                            {canReorderItems && section.status === "OPEN" && (
                              <span className="inline-flex gap-1">
                                <button
                                  aria-label={`${item.productNameSnapshot}上移`}
                                  disabled={busy || detailLoading || index === 0}
                                  className="rounded border px-2 py-1"
                                  onClick={() =>
                                    void moveStocktakeItem(section, item.id, -1)
                                  }
                                >
                                  上移
                                </button>
                                <button
                                  aria-label={`${item.productNameSnapshot}下移`}
                                  disabled={
                                    busy ||
                                    detailLoading ||
                                    index === section.items.length - 1
                                  }
                                  className="rounded border px-2 py-1"
                                  onClick={() =>
                                    void moveStocktakeItem(section, item.id, 1)
                                  }
                                >
                                  下移
                                </button>
                              </span>
                            )}
                            {canEditItems && section.status === "OPEN" && (
                              <button
                                disabled={
                                  busy ||
                                  detailLoading ||
                                  section.items.length <= 1
                                }
                                className="rounded border border-red-200 px-2 py-1 text-red-700"
                                onClick={() => confirmRemoveItem(item)}
                              >
                                移除
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {editable && (
                  <div>
                  <div className={sheet.toolbar}>
                    <span className="text-xs text-gray-500">
                      批量填充只处理空白项，不覆盖已有实盘值
                    </span>
                    <button
                      disabled={busy || detailLoading}
                      className="rounded border px-3 py-1.5"
                      onClick={() =>
                        fillEmptyCountedQuantities(section, "BOOK")
                      }
                    >
                      空白按账面填充
                    </button>
                    <button
                      disabled={busy || detailLoading}
                      className="rounded border px-3 py-1.5"
                      onClick={() =>
                        fillEmptyCountedQuantities(section, "ZERO")
                      }
                    >
                      空白填零
                    </button>
                    <button
                      disabled={busy || detailLoading}
                      className="rounded border px-3 py-1.5"
                      onClick={() => void downloadImportTemplate(section)}
                    >
                      下载导入模板
                    </button>
                    <label className="cursor-pointer rounded border px-3 py-1.5">
                      导入盘点结果
                      <input
                        aria-label={`${section.name}导入盘点结果文件`}
                        className="sr-only"
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        disabled={busy || detailLoading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) void previewImportFile(section, file);
                        }}
                      />
                    </label>
                    <button
                      disabled={busy || detailLoading}
                      className="rounded border px-3 py-1.5"
                      onClick={() => void saveSection(section, false)}
                    >
                      {returnPage === "multi-count"
                        ? "保存子单"
                        : "保存我的分区"}
                    </button>
                    {returnPage === "multi-count" ? (
                      <button
                        disabled={busy || detailLoading}
                        className="rounded bg-ink px-3 py-1.5 text-white"
                        onClick={() => confirmMultiSubmit(section)}
                      >
                        提交审核
                      </button>
                    ) : (
                      <button
                        disabled={busy || detailLoading}
                        className="rounded bg-ink px-3 py-1.5 text-white"
                        onClick={() => void saveSection(section, true)}
                      >
                        提交我的分区
                      </button>
                    )}
                  </div>
                  {importPreview?.sectionId === section.id && (
                    <div className="mt-3 rounded border border-border bg-white p-3" role="dialog" aria-label="盘点结果导入预览">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong>导入预览 · {importPreview.fileName}</strong>
                        <span>可应用 {importPreview.validCount} 行，错误 {importPreview.errorCount} 行</span>
                      </div>
                      <div className="mt-2 max-h-64 overflow-auto">
                        <table aria-label="盘点结果导入明细">
                          <thead><tr><th>行号</th><th>物品编码</th><th>物品名称</th><th>库存单位</th><th>实盘数量</th><th>差异说明</th><th>校验</th></tr></thead>
                          <tbody>{importPreview.rows.map(row => (
                            <tr key={`${row.rowNo}-${row.productCode}`}>
                              <td>{row.rowNo}</td><td>{row.productCode || "—"}</td><td>{row.productName}</td><td>{row.inventoryUnit || "—"}</td><td>{row.countedQuantity || "—"}</td><td>{row.reason || "—"}</td><td className={row.error ? "text-red-700" : "text-green-700"}>{row.error || "可应用"}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                      <div className="mt-3 flex justify-end gap-2">
                        <button className="rounded border px-3 py-1.5" onClick={() => setImportPreview(null)}>取消</button>
                        <button disabled={Boolean(importPreview.errorCount)} className="rounded bg-ink px-3 py-1.5 text-white disabled:opacity-50" onClick={applyImportPreview}>应用到录入（尚未保存）</button>
                      </div>
                    </div>
                  )}
                  </div>
                )}
                {returnPage === "multi-count" &&
                  canWrite &&
                  ["DRAFT", "COUNTING"].includes(count.status) &&
                  section.status === "SUBMITTED" && (
                    <div className={sheet.toolbar}>
                      <button
                        disabled={busy || detailLoading}
                        className="rounded bg-ink px-3 py-1.5 text-white"
                        onClick={() => confirmMultiSubmit(section)}
                      >
                        提交审核
                      </button>
                    </div>
                  )}
              </section>
            );
          })}
          {count.adjustments.length > 0 && (
            <div className="rounded-xl bg-green-50 p-4">
              <h3>盘盈盘亏记录（历史保留）</h3>
              {count.adjustments.map((row) => (
                <p key={row.id}>
                  {canReadInventoryReports ? (
                    <Link
                      className="underline"
                      href={`/v2/supply-chain/stocktake/${
                        row.type === "PROFIT" ? "profit" : "loss"
                      }`}
                    >
                      {row.no} · 第{row.cycle}轮 ·{" "}
                      {row.type === "PROFIT" ? "盘盈" : "盘亏"} ·{" "}
                      {row.status === "REVERSED" ? "已冲销" : "已过账"} ¥
                      {Number(row.totalAmount).toFixed(2)}
                    </Link>
                  ) : (
                    <>
                      {row.no} · 第{row.cycle}轮 ·{" "}
                      {row.type === "PROFIT" ? "盘盈" : "盘亏"} ·{" "}
                      {row.status === "REVERSED" ? "已冲销" : "已过账"} ¥
                      {Number(row.totalAmount).toFixed(2)}
                    </>
                  )}
                </p>
              ))}
            </div>
          )}
          <section className="rounded-xl border border-border p-4" aria-label="单据操作日志">
            <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">操作日志</h3><button disabled={logsLoading} onClick={() => void loadLogs(false)}>{logsLoaded ? "刷新日志" : logsLoading ? "加载中…" : "加载操作日志"}</button></div>
            {logsLoaded && (logs.length ? <ol className="mt-3 space-y-2 text-caption">{logs.map(log => <li key={log.id}><time>{new Date(log.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time> · {log.actor} · {log.action}</li>)}</ol> : <p className="mt-3 text-caption text-gray2">暂无操作日志</p>)}
            {logsLoaded && logsHasMore && <button className="mt-3" disabled={logsLoading || !logsCursor} onClick={() => void loadLogs(true)}>加载更多</button>}
          </section>
        </section>
      )}
      <ConfirmSheet {...confirm} />
    </main>
  );
}
