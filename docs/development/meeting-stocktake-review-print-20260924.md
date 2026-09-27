# 供应链盘点复盘与纸质打印

## 范围

- 从供应链盘点管理表格的在线盘点单进入 `/v2/supply-chain/stocktake/count/:id`；历史导入基准仍只保留原查看方式。
- 新页只读取既有 `GET /api/inventory-counts/:id`，没有创建、保存、确认、冲销或取消操作。
- 默认仅展示“已盘且有差异”的行；`countedQuantity: null` 显示为“未盘”，不会作为零处理。可切换为全部明细并按编码、名称、规格搜索。
- 打印内容包含机构、单号、日期、状态、账面/实盘/差异数量和金额、中文原因及证据张数。打印件通过临时 portal 直接挂到 `body`；打印样式仅显示该纸张区域，隐藏应用壳、导航和交互，并重复表头、避免截断长行。
- 当前打印范围会明确“仅已盘且有差异”或“全部明细”、搜索条件和条目数。整单差异金额明确标为整单金额，不伪装为筛选结果合计。
- 纸质打印明确使用 A4 横向、10mm 页边距和可读的 10pt/9pt 正文/表格字号；商品/规格与原因说明列使用固定的较宽比例，数字列保持窄列。点击“打印复盘单”时，会先等待字体就绪、按 A4 横向可打印宽度测量真实行高，再显式拆成每页都有文档头与表头的页面，React 同步提交并等待两帧布局后才打开原生打印框；不按固定行数分页、不截断或缩小内容。首次原生 Cmd+P 也通过同步 `beforeprint` 准备同一套分页；筛选、换单和卸载会使已准备的分页失效，不能把旧行写入新单据。
- 单个原始表格行超过一页时，打印专用模型会按 Unicode 码点把“商品/规格”和“原因说明”切为经同一 A4 隐藏表格实际测量的片段。每片都重复短商品编码和单位，续片标为“（续）”；账面、实盘、差异数量、差异金额和证据张数只出现在首片，整单差异金额也只出现在首个页面头，避免纸面上把金额或总计误读为重复。循环每次至少前进一个码点并有片段上限，避免异常测量无限循环。
- `beforeprint` 会切入 print 媒体；因此两个测量 portal 在 print 媒体中明确覆盖应用壳的隐藏规则：保持 `display:block`、A4 实际可打印宽度 `277mm`、固定离屏和 `visibility:hidden`。这样可取到真实布局高度，同时不参与纸张流或露出在纸面。

## 验证

- 恢复本工作树独立依赖后，`PATH=/Users/weiyi/.nvm/versions/node/v20.20.2/bin:$PATH pnpm --filter @dianjie/web exec vitest run 'src/app/v2/supply-chain/stocktake/count/[id]/page.test.tsx'` 为 1 文件、12 测试通过；覆盖只读 GET、默认差异筛选、全部明细、未盘显示、中文映射、证据键优先、隔离打印件、搜索与纸张同步、零差异空态、路由切换失败后恢复、移动端底部留白，以及非均匀真实行高在页容量边界的显式拆页（含 16px 文档头间距）、每页重复文档头、超高行的 Unicode 安全文本分片、原文不丢不重、续片标识、金额和证据仅首片、首次 `beforeprint`、print 媒体下测量 portal 覆盖隐藏规则、筛选后的旧分页失效、字体等待期间换单和卸载取消打印。盘点列表入口合同测试已在此前的 `management-workspace.test.tsx` 回归中通过。
- 真实浏览器 print-media 计算样式检查：使用本机 Chrome headless 直接加载本页源码中的内嵌 CSS、`emulateMedia('print')`，两个 portal 均观察到 `display:block`、`visibility:hidden`、`position:fixed`、宽 `1046.92px`（277mm），且示例表格行高为 `21px`。这验证了 print 媒体不再把测量节点设为 `display:none`；它不是 Safari 实体纸张验收。
- `PATH=/Users/weiyi/.nvm/versions/node/v20.20.2/bin:$PATH pnpm --filter @dianjie/web exec tsc --noEmit` 与 `git diff --check`：通过。
- 最新完整 Web 回归为 70 文件、879 测试通过；隔离生产构建显式使用 `NEXT_PUBLIC_PREVIEW_TENANT_SLUG=noon-ui`和本地4334 API，生成180页并 exit0。构建自动加入的临时 `tsconfig` include 已移除，项目 `tsconfig.json` 与 HEAD 一致。
- 隔离预览库的60条长表在610px安全预算下形成7个连续逻辑页，行数为9/9/9/9/9/9/6，首尾编码为 `PRINT-QA-001` / `PRINT-QA-060`，无丢失、无重复。这是页面分组与数据完整性证据，仍不代替 Safari 物理缩略图。
- Safari原生打印预览最终验收通过：刷新到610px构建并选择全部60项后，在A4、横向、100%缩放、关闭页眉页脚条件下显示7页；滚动核对1—7页缩略图均有文档头、表头和表格内容，没有旧660px版的交替空白页或单独溢出尾行页。第7页含最后一组数据；与页面首尾 `PRINT-QA-001` / `PRINT-QA-060` 及逻辑分页 `9/9/9/9/9/9/6`交叉核对，无丢失、无重复。未点击系统最终“打印”，没有向打印机发送任务。
- `DATABASE_URL=postgresql://weiyi@localhost:5432/dianjie_meeting_noon_20260924_ci pnpm --filter @dianjie/api exec vitest run --config vitest.integration.config.ts tests/routes/inventoryCounts.integration.test.ts --pool=forks --maxWorkers=1`：1 文件、5 测试通过；验证 `SUPPLY_CHAIN` 可 GET 同租户盘点单、跨租户详情为 404，且 `start`、`items`、`submit`、`confirm`、`reverse`、`cancel` 写端点均为 403。跨租户夹具在 `finally` 按租户精确清理。

## 验收边界

- Safari 60行常规长表的A4横向物理分页已验收通过；超高单行的Unicode分片仍由组件测试覆盖文字不丢不重、续片标识和金额/证据仅首片。当前隔离预览夹具没有构造超过一整张A4的真实单行，因此不把该极端路径表述为已完成原生纸张实测。
- 不改变 API、权限、门店盘点写流程、管理表头或 Excel 导出字段。
