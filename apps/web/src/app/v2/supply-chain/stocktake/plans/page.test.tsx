// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WarehouseStocktakePlansPage from "./page";

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a> }));
const authState = vi.hoisted(() => ({ user: { id: "user-1", role: "ADMIN" } }));
vi.mock("@/lib/v2-auth", () => ({ apiFetch: vi.fn(), getUser: () => authState.user }));
import { apiFetch } from "@/lib/v2-auth";

const mockFetch = vi.mocked(apiFetch);
const warehouses = [{ id: "wh-a", code: "A", name: "A仓" }, { id: "wh-b", code: "B", name: "B仓" }];
const products = [{ id: "p-1", code: "P1", name: "土豆", inventoryUnit: "kg", unit: "kg" }];
const plans = [{ id: "plan-1", no: "WSP-1", name: "每日盘点", status: "ENABLED", warehouseId: null, countScope: "ALL", selectionRule: "ALL_ENABLED", periodUnit: null, note: null, rowVersion: 0, items: [] }];
const policy = (warehouse: string, name = "土豆") => ({ warehouse: { id: warehouse, name: warehouse }, rows: [{ id: null, product: { ...products[0], name }, canCount: true, defaultIncluded: true, reason: null, rowVersion: 0 }] });

function setup() {
  mockFetch.mockImplementation(async (path) => {
    if (path === "/api/warehouse-stocktakes/options") return { warehouses, products } as any;
    if (path === "/api/warehouse-stocktake-plans") return [] as any;
    if (path === "/api/warehouse-stocktake-plans/policies/wh-a") return policy("wh-a") as any;
    if (path === "/api/warehouse-stocktake-plans/policies/wh-b") return policy("wh-b", "白菜") as any;
    throw new Error(`unexpected API: ${path}`);
  });
}

function renderPage() {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); act(() => root.render(<WarehouseStocktakePlansPage />));
  return { container, root };
}
async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error("waitFor timeout"); await act(async () => new Promise((resolve) => setTimeout(resolve, 10))); }
}
function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => { const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value); input.dispatchEvent(new Event("change", { bubbles: true })); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function button(container: Element, text: string) { return Array.from(container.querySelectorAll("button")).find((row) => row.textContent === text) as HTMLButtonElement; }
function enabledButton(container: Element, text: string) { const found = button(container, text); return Boolean(found && !found.disabled); }

describe("盘点方案与政策管理", () => {
  beforeEach(() => { authState.user = { id: "user-1", role: "ADMIN" }; localStorage.setItem("tenant", JSON.stringify({ id: "tenant-1" })); sessionStorage.clear(); mockFetch.mockReset(); setup(); });
  afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

  it("方案创建响应丢失后双击与重试使用完全相同的requestKey和body", async () => {
    const base = mockFetch.getMockImplementation()!; const bodies: string[] = []; let writes = 0;
    mockFetch.mockImplementation(async (path, init) => {
      if (path === "/api/warehouse-stocktake-plans" && init?.method === "POST") {
        bodies.push(String(init.body)); writes += 1;
        if (writes === 1) throw new Error("网络响应丢失");
        return { replayed: true, plan: {} } as any;
      }
      return base(path, init);
    });
    let page = renderPage(); await waitFor(() => enabledButton(page.container, "创建方案"));
    change(page.container.querySelector('[aria-label="方案名称"]') as HTMLInputElement, "每日盘点");
    await act(async () => { button(page.container, "创建方案").click(); button(page.container, "创建方案").click(); });
    expect(writes).toBe(1);
    await waitFor(() => enabledButton(page.container, "重试原方案请求"));
    act(() => page.root.unmount()); page.container.remove(); page = renderPage();
    await waitFor(() => enabledButton(page.container, "重试原方案请求"));
    await act(async () => button(page.container, "重试原方案请求").click());
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]).requestKey).toBeTruthy();
    act(() => page.root.unmount());
  });

  it("政策保存响应丢失后重放原body，不重新生成requestKey", async () => {
    const base = mockFetch.getMockImplementation()!; const bodies: string[] = []; let writes = 0;
    mockFetch.mockImplementation(async (path, init) => {
      if (path === "/api/warehouse-stocktake-plans/policies/wh-a/p-1" && init?.method === "PUT") {
        bodies.push(String(init.body)); writes += 1; if (writes === 1) throw new Error("响应丢失"); return {} as any;
      }
      return base(path, init);
    });
    let page = renderPage(); await waitFor(() => Boolean(button(page.container, "保存政策")));
    await act(async () => button(page.container, "保存政策").click());
    await waitFor(() => enabledButton(page.container, "保存政策"));
    act(() => page.root.unmount()); page.container.remove(); page = renderPage();
    await waitFor(() => enabledButton(page.container, "保存政策"));
    await act(async () => button(page.container, "保存政策").click());
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
    act(() => page.root.unmount());
  });

  it("方案PATCH响应丢失后刷新仍重放完全相同的requestKey和body", async () => {
    const bodies: string[] = []; let writes = 0;
    mockFetch.mockImplementation(async (path, init) => {
      if (path === "/api/warehouse-stocktakes/options") return { warehouses, products } as any;
      if (path === "/api/warehouse-stocktake-plans" && !init?.method) return plans as any;
      if (path === "/api/warehouse-stocktake-plans/policies/wh-a") return policy("wh-a") as any;
      if (path === "/api/warehouse-stocktake-plans/plan-1" && init?.method === "PATCH") {
        bodies.push(String(init.body)); writes += 1; if (writes === 1) throw new Error("响应丢失"); return plans[0] as any;
      }
      throw new Error(`unexpected API: ${path}`);
    });
    let page = renderPage(); await waitFor(() => enabledButton(page.container, "停用"));
    await act(async () => button(page.container, "停用").click());
    await waitFor(() => enabledButton(page.container, "重试原更新"));
    act(() => page.root.unmount()); page.container.remove(); page = renderPage();
    await waitFor(() => enabledButton(page.container, "重试原更新"));
    await act(async () => button(page.container, "重试原更新").click());
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0]).requestKey).toBeTruthy();
    act(() => page.root.unmount());
  });

  it("损坏的恢复记录会冻结新写入且不会静默生成新requestKey", async () => {
    sessionStorage.setItem("dj:stocktake-plan-write:tenant-1:user-1:plan", "{broken");
    const page = renderPage(); await waitFor(() => Boolean(button(page.container, "核实后清除损坏记录")));
    expect(button(page.container, "创建方案").disabled).toBe(true);
    expect(mockFetch.mock.calls.some(([path, init]) => path === "/api/warehouse-stocktake-plans" && init?.method === "POST")).toBe(false);
    act(() => page.root.unmount());
  });

  it("财务角色只能查看，页面不展示方案或政策写按钮", async () => {
    authState.user = { id: "finance-1", role: "FINANCE" };
    const page = renderPage(); await waitFor(() => page.container.textContent?.includes("盘点方案（只读）") ?? false);
    expect(button(page.container, "创建方案")).toBeUndefined(); expect(button(page.container, "保存政策")).toBeUndefined();
    act(() => page.root.unmount());
  });

  it("仓库A的慢响应不会覆盖切换后的仓库B政策", async () => {
    let resolveA!: (value: any) => void;
    const delayedA = new Promise((resolve) => { resolveA = resolve; });
    mockFetch.mockImplementation(async (path) => {
      if (path === "/api/warehouse-stocktakes/options") return { warehouses, products } as any;
      if (path === "/api/warehouse-stocktake-plans") return [] as any;
      if (path === "/api/warehouse-stocktake-plans/policies/wh-a") return delayedA as any;
      if (path === "/api/warehouse-stocktake-plans/policies/wh-b") return policy("wh-b", "白菜") as any;
      throw new Error(`unexpected API: ${path}`);
    });
    const page = renderPage(); await waitFor(() => (page.container.querySelector('[aria-label="政策仓库"]') as HTMLSelectElement | null)?.options.length === 2);
    change(page.container.querySelector('[aria-label="政策仓库"]') as HTMLSelectElement, "wh-b");
    await waitFor(() => page.container.textContent?.includes("白菜") ?? false);
    resolveA(policy("wh-a", "土豆")); await act(async () => Promise.resolve());
    expect(page.container.textContent).toContain("白菜"); expect(page.container.textContent).not.toContain("P1 土豆");
    act(() => page.root.unmount());
  });
});
