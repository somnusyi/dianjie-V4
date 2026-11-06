# G02 与新库存事实的发布、恢复门槛

## 当前恢复语义（2026-11-02）

已区分两种情况：`same-version-redeploy`使用精确相同、固定摘要的已验镜像重建运行服务，能力范围是运行恢复；`compatible-version-rollback`才表示软件版本回退，需要对应版本差异与兼容证据。不得为了满足不同摘要而制造无业务依据的恢复版本，也不得把同版本重建说成能修复程序逻辑缺陷。

新manifest使用`packageKind=compatible-recovery`并显式固定来源、目标镜像和恢复类型，证明材料也须绑定这些字段。普通前向包仍不能通过；旧1.3.2面对密文、提交预占、调拨、净成本与新会话事实仍必须拒绝。全部文件哈希、五能力、精确密钥恢复回执、错目标拒绝、禁止回写业务库和降级结构的保护继续有效。

本地主树59项相关回归通过；真实同版本重建前后157表行数与哈希一致。重建后的五能力写入验收及完整manifest门槛复演仍需独立证据，不能只据控制器单测销项。下方旧“必须不同镜像”的描述属于此前方案，不再适用于同版本运行恢复；它们对软件回退的边界仍保留。


此文和候选工具仅准备代码与验证设计，没有修改线上、恢复数据库或转换真实凭据。

## 原 1.3.2 回退脚本不能作为本轮的恢复包

已只读检查 `tmp/release-1.3.2-20261028/server-rollback.py`：它检查旧 `.env`/schema文件哈希和旧程序归档后，恢复旧 API/Web 或旧容器；没有识别 `djenc:v1:`、提交预占标记、新调拨事实或新浏览器会话。它还包含旧健康版本常量，不能复制成新版本回退脚本便直接执行。

密文转换后，原 1.3.2 的企微服务、美团 tokenStore 把数据库字段直接当明文使用；回退后会把密文当供应商凭证发送，不能称为可用。只恢复 credential-vault 文件也不够：读取方必须显式解密、所有刷新/配置写入方必须继续加密、日志和返回字段继续脱敏。不得把数据库凭据自动改回明文来让旧程序工作。

此外，P01 `SUBMISSION_V1` 已经预占的订单，旧接单流程不理解新标记；P02 旧调拨仅改状态，不能解释部分实收、退回、损坏流水。原数据库保留不等于旧业务程序能安全使用新事实。

## 必须保留的源码范围

恢复包以已批准的旧业务基线为来源，只回退不破坏新事实的不兼容变更。以下安全层和新事实兼容层应保留，或者由经过同样验收的兼容实现替代；不能盲目覆盖为 1.3.2 文件。

| 范围 | 具体源码 |
|---|---|
| 凭据封装和使用方 | `apps/api/src/lib/credential-vault.ts`；`services/wecom.ts`；`services/meituan/tokenStore.ts`；`routes/wecom.ts`；`routes/stores.ts` |
| 请求、第三方日志脱敏 | `apps/api/src/index.ts`；`lib/safe-request-log.ts`；`lib/provider-log-safety.ts`；`services/meituan/callLogger.ts`、`client.ts`；`routes/meituanAdmin.ts`；`services/notify/index.ts`；`packages/db/index.js`、`src/index.ts` |
| 浏览器/API安全会话 | `lib/browser-session.ts`、`authenticate-principal.ts`、`revoke-session.ts`、`idempotency.ts`；`services/authTokens.ts`、`browserSessionOrder.ts`；`routes/auth.ts`、`users.ts`、`wecom.ts` |
| 前端会话匹配 | `apps/web/src/lib/v2-auth.ts`、`api.ts`；`store/auth.ts`；`components/session-bootstrap.tsx`、`AppLayout.tsx`、`ImageUploader.tsx`、`v2/user-menu.tsx`；`app/layout.tsx`；各登录/退出/企微桥接页；`app/api/[...path]/route.ts`；Sentry三端配置及`lib/safe-telemetry.ts`。完整构建文件和BUILD_ID必须固定哈希 |
| P01事实兼容 | `routes/orders.ts`；`services/orderSubmissionReservation.ts`、`warehouseLedger.ts`、`supplierStockReservation.ts`、`deliveryItemRemoval.ts`、`replenishmentOrderService.ts` |
| P02事实兼容 | `routes/storeTransfers.ts`；`services/storeTransferPosting.ts`、`storeInventory.ts`、`inventoryCosting.ts`；对应调拨页面及报表读取 |
| P05历史依据 | `routes/inventoryReports.ts`；`services/inventoryReports.ts`、`inventoryNetCost.ts`、`inventoryNetCostRead.ts`、`inventoryNetCostBasis.ts`、`inventoryNetReportProjection.ts`；对应成本材料页面及“待核算”显示 |
| 持久化 | 保留现有前向schema、迁移结果和匹配生成的Prisma运行客户端；保留预占、调拨、成本依据和浏览器时钟。不得执行down migration、恢复旧业务库或回放旧余额 |

全文件覆盖前仍须检查相对已发布基线的差异，避免夹带其他未批准改动。若问题恰在这些保留核心内，需要前修或真正懂新事实的兼容实现；不能声称原1.3.2整包可直接救回。

## 可执行只读门槛

`scripts/release/rollback_compatibility.py` 默认 `--mode publish`。它只查询数据库、校验文件和在无数据库/外部配置的子进程中测试纯vault模块，不调用回退驱动、恢复命令或迁移。

数据库连接由指定环境变量读取，不放命令行。正式仅允许 `dianjie_v4`，测试仅允许 `dianjie_v4_uat`；隔离验证仅允许回环15439/15449上的 `dianjie_*test`。SQL使用显式只读事务和连接只读选项；数据库仅返回新事实存在标记和加密keyId，不返回凭据值、订单内容或个人信息。

它检测：`djenc:v1:`及未知格式；SUBMISSION_V1或冻结供应商单位；新调拨流水/部分实收；净成本核定；BrowserSessionClock。未知凭据格式直接拒绝。回退模式按已存在事实要求兼容能力；发布模式无论当前是否已有数据，都要求五项兼容能力预先完成。

没有经过验证的兼容恢复包时发布必须失败。必须传入：

- 独立受信发布记录中已批准的 compat-manifest SHA256；不能临时对拿到的陌生manifest现算现信。
- `packageKind=compatible-rollback`，明确禁止业务数据库恢复、凭据回写明文和结构回退。
- 全部必需API兼容文件、完整API程序归档(api/application.tar.gz)、匹配生成的Prisma运行客户端归档(packages/db/client.tar.gz)、Web程序归档/BUILD_ID、DB运行适配和schema的产物哈希；缺少或漂移拒绝。
- 与整套产物fingerprint绑定的真实恢复验收证据，涵盖五项能力及“不重写业务数据、错环境拒绝、驱动强制执行兼容门槛”。声明能力本身不能代替这些验收。
- 已密封的AES keyring及真正离线私钥恢复回执；它必须覆盖数据库引用的keyId和当前运行keyring的全部keyId，而且规范化keyring SHA必须完全一致，避免同名换key误判。

示例（只读）：

```
python3 scripts/release/rollback_compatibility.py \
  --target uat --mode publish \
  --database-url-env DATABASE_URL \
  --credential-keys-env CREDENTIAL_ENCRYPTION_KEYS \
  --candidate-root /private/staging/compatible-recovery-package \
  --compat-manifest /private/staging/compatible-recovery-package/compat-manifest.json \
  --approved-manifest-sha256 <已审核发布记录固定的SHA256>
```

不得将数据库URL或keyring内容贴进命令、工单或输出。工具不会执行任何恢复操作。它需要被新发布控制器和兼容恢复驱动作为强制门槛调用；现存旧线上脚本未被本候选自动修改，因此不能绕过控制器手工运行旧脚本。

## 实际恢复验收设计

1. 使用候选恢复产物及其真正依赖，在独立库生成覆盖新格式的凭据、SUBMISSION_V1预占、部分调拨、成本核定和有序会话，再固定数据库基线。
2. 保留该库及keyring，切换兼容恢复包程序。不得恢复业务数据库或自动转换密文为明文。
3. 企微缓存读取/刷新、美团token读取/更新、配置保存全部使用合成服务和凭据；原密文能读取，新写仍是密文，跨租户上下文/错误key拒绝，日志/接口无秘密。
4. 原已预占单接单不重复预占；改单/取消按原仓原单位释放；原调拨发10收9退1或损坏1按原成本闭环，流水和两店余额只记一次。现有净成本依据仍可读取；旧未知成本不得变0。
5. 新cookie/同用户别会话/跨标签/注销及权限变化验证，Web/API与HTTPS入口保持配套。
6. 对比操作前后业务记录、库存、金额、流水与幂等标识，只允许本轮明确操作的变化；错误环境和旧manifest必须拒绝。记录镜像/归档、BUILD_ID、源码范围和测试产物哈希。
7. 将证据fingerprint写入独立审核过的兼容manifest，再把manifest SHA固定到发布记录。新发布及真正恢复前在写入排空/发布锁内重跑只读gate，防止检查后又出现新事实。

当前缺口：候选工具和合成测试不等于真实兼容恢复包已构建验收。尚需完整恢复包组装、API/Web构建、前向schema客户端匹配、恢复演练、发布控制器接入和真实离线key保管证据。在这些门槛完成前，不得宣称可安全回退或允许发布通过。

## 本地证据

2026-10-29用已固定的1.3.3源码候选范围清单与兼容门槛逐项比对：42个变更API源码文件中，门槛原覆盖37个。已将P01库存可用量`routes/products.js`、P05净成本依据`routes/inventoryNetCostBasis.js`加入必须覆盖的兼容产物，14项门槛测试通过。现覆盖39个变更API源码；剩余3个为两支一次性迁移helper和版本常量，须由运维源码/版本构建记录单独固定。前端另有28项覆盖文件，只能由完整Web构建及BUILD_ID核对；仅列API兼容文件不能证明前端会话匹配。静态范围结果见`tmp/four-gap-20261028/compatibility-source-coverage-20261029.json`。

目前源范围比对也表明，新事实和安全会话涉及绝大多数变更运行文件。将现有前向1.3.3镜像重新命名成“兼容回退”不会形成独立的旧业务恢复实现；仍需构造、测试真正可切换的恢复产物及驱动。

另发现仓库旧`scripts/rollback.sh`可直接解旧程序备份，`--with-db`还会用`pg_restore --clean`覆盖业务库，完全绕开此门槛。2026-10-29已在本地主树将该旧入口改为无条件`BLOCKED`，四类旧调用均以退出码2拒绝且不连接服务器；旧`deploy.sh`的失败提示和`scripts/README.md`同步纠正。更新后的G02运维源码在`staged-1.3.3-ops-v3`，已审前向UAT交付候选在`uat-delivery-v3`；两者不含兼容恢复驱动或完成的恢复演练。本地禁用**不会自动修改服务器上历史脚本**，发布控制器仍必须在目标环境强制接入门槛，且不能允许手工绕过旧服务端脚本。

`guard-tests.log`：旧13项门槛测试记录；2026-10-29增加两项路由覆盖拒绝用例后，当前14项重跑通过，包含实际编译vault模块的加解密/错误上下文测试；manifest结构的合成fixture仅证明拒绝逻辑，不冒充完整业务恢复演练。

`read-only-proof.json`：在已核实的15449合成库以只读查询确认SUBMISSION_V1、调拨事实、成本核定和浏览器时钟存在；未验证旧1.3.2恢复包被拒绝。周度关键表计划包含BrowserSessionClock，实际pg_dump/pg_restore列表同时包含其TABLE DATA和会话sequence的SEQUENCE SET；临时dump已经删除，数据库未改。

## 2026-10-29 本地恢复控制器与故障注入

新增 `scripts/release/rehearse_compatible_switch.py`，只接受专用15449合成库、本机Colima及本机3263入口。默认只读预检，只有显式 `--execute` 才切换；不支持正式/UAT目标，不运行迁移、数据库恢复、凭据转换或镜像拉取。采用独占锁，要求独立固定的计划/兼容manifest指纹，控制器、只读gate及OCI校验工具均须纳入兼容包哈希。

流程为：核对容器、镜像、专用网络、回环端口和合成配置 → 核对归档与镜像身份 → 兼容gate → 停止旧Web/API写入入口 → 重跑gate → 启动候选 → 版本/数据库健康检查。前向包直接拒绝，不能以原前向镜像对改标签充当兼容恢复。成功后保留停止的旧容器；失败则逐项清理候选并尝试恢复旧服务。创建调用响应丢失时按预登记名称和本次唯一标签找回；Ctrl-C/SIGTERM进入相同恢复路径。SIGKILL/主机崩溃的持久恢复日志与重入尚未实现，不能把可处理信号测试扩大为整机故障恢复。

独立只读审查指出清理报错跳过恢复、创建响应丢失漏清理、用户中断绕过恢复三项问题，已修正并补测试。13项控制器回归通过。真实演练首次使用Docker内部网络时，容器内健康正常而宿主端口不可达；已改为独占普通bridge，API不开放宿主端口，Web仅绑定127.0.0.1:3263，严格核对网络成员和PREVIEW配置。

真实Docker故障注入通过三项：排空后gate拒绝、候选启动后健康失败、daemon创建成功但客户端丢失响应。每次均恢复原固定镜像对健康；157张public表逐表行数与SHA256相同，临时容器/网络已清理，DB恢复仅bridge网络。真实v4前向交付包由CLI拒绝且容器状态不变。

本次仅验证**控制器失败恢复机制**：故障注入刻意使用同一前向镜像对，调用只读事实探测回调，没有伪造兼容manifest或已通过的业务证据，不构成兼容包验收，也未切换线上。证据 `../qa/evidence/FOUR-GAPS-20261028/COMPATIBLE-SWITCH-CONTROLLER.json`。独立恢复源码/产物、五项能力完整业务演练、崩溃重入、发布控制器接入与真实离线密钥托管仍待完成。

### 持久化中断记录（本地准备）

`switch_journal.py` 现已接入控制器执行路径，停旧服务及创建候选前写入操作阶段、固定容器身份、镜像和计划/控制器指纹；不保存环境变量、密钥或数据库连接串。文件权限0600，使用临时文件、fsync、原子替换及目录fsync。未完成记录会阻止下一次执行覆盖现场；只有`switched`或`previous_restored`为终态。控制器执行前的独占锁仍覆盖整个操作。

六个非终态分别由独立子进程写入后执行真实SIGKILL：记录可重新读取，重启尝试均被拒绝且原记录字节不变。此证据只证明进程被杀后的持久记录和拒绝覆盖，不证明断电后的物理磁盘耐久性或自动恢复。

`inspect_switch_journal.py --journal <记录路径>`只读检查本机Docker：分别报告原服务和候选是否实际存在、是否运行、是否在记录网络上。镜像、名称、角色、操作标签漂移时拒绝，不从旧日志推断“仍在运行”，也不启动、停止或删除容器。真实历史演练记录显示非终态，但当前四个容器都已清理；工具正确报告不存在，未重启。

仍待完成：基于现场核验结果的受控恢复入口、真正独立兼容产物与五项业务切换验收。不得绕过兼容gate、伪造通过证据或把同镜像故障注入升级为兼容包验收。旧控制器证据保留其当时源码指纹，当前状态以新增`SWITCH-JOURNAL.json`为准。


2026-10-29恢复工具继续：持久日志读取/写入现严格校验嵌套结构、完整容器ID、镜像指纹、操作ID/角色专属名称、网络及角色冲突，避免异常选择器进入Docker；清理候选额外核对镜像，不因名称/标签相同删除错镜像。22项控制器/日志/现场核对回归通过，含6阶段真实SIGKILL、嵌套篡改拒绝、错误选择器不调用Docker、同名错镜像拒绝删除；兼容gate14项通过。6份历史实际日志均可校验且容器已不存在；另一个同前缀0644结果报告被正确拒绝，不当作日志。

真实Docker三故障（排空后拒绝、候选健康失败、创建响应丢失）用最新前向镜像重跑通过，157张public表行数和SHA未变，全部日志终态previous_restored，临时容器/网络清理。证据SWITCH-IDENTITY-VALIDATION.json；仅控制器失败恢复，不是独立兼容包验收。受控中断恢复入口、独立恢复源码/产物及五项业务切换演练仍待完成；这些本地恢复脚本尚不在前向v6包，不影响其已审镜像事实。


### 受控中断续接入口（仅本地）

`rehearse_compatible_switch.py --resume` 使用同一个用户级锁和固定日志；原有计划、兼容包、manifest及其批准SHA参数仍全部必需。默认只预检，`--resume --execute`才执行。必须是非终态，计划/控制器指纹、两组镜像、容器完整ID与名称、专用网络、回环端口、角色和操作标签均匹配；原服务容器缺失或替换、额外网络成员、残留候选配置/密钥指纹不符均拒绝。控制器代码发生变化时旧记录不能直接续接，需保留对应审定控制器或重新人工核对，不能修改日志指纹伪装匹配。

通过现场校验后，重新读取日志并比较，清理已核实的残留候选，幂等排空旧服务、重跑原兼容gate，再创建候选并检查健康。日志阶段不代替容器实况；同一记录若已为终态不重复执行。失败仍走旧服务恢复路径，不覆盖业务库。中断后若兼容门槛未通过，会保留现场并拒绝操作，不承诺自动恢复可用性。

该入口实现并不代表独立兼容恢复包已通过验收；用前向镜像做运输故障注入仍只能证明控制器行为。


2026-10-29恢复CLI入口补修：独立只读审查发现main()内SIGTERM处理函数interrupted覆盖同名续接记录，导致普通执行误走resume、续接传入函数。新增入口回归修复前4项中3失败，处理函数改名后控制器/续接/日志全30项通过，覆盖正常执行、续接、dry-run及失败恢复信号处理器。证据SWITCH-CLI-DISPATCH.json。外部Docker/gate在入口测试中mock；此前真实Docker adapter演练不证明完整CLI入口已通过。控制器指纹已变化，不篡改旧日志伪装匹配。v11业务镜像不变；独立兼容恢复包和完整业务验收仍未完成。


2026-10-29定向修复恢复演练：在专用15449同库，以真实v10 API/Web镜像复现HC-ADJUST-REVERSE余10kg但净额/单价/冲销净额均null；通过DockerSwitch排空切换实际v11 API和相同Web后得到10kg/净100/均价10/冲销净额-110。两源码仅inventoryNetCost.ts及inventoryNetCostRead.ts不同，已固定前后SHA。157张public表逐表行数和内容哈希全过程不变；演练收尾恢复原容器后删除全部临时容器/网络。证据FAULT-TARGETED-REPAIR-V10-V11.json，14项兼容gate回归通过。

本次是已知v10故障到v11修复的实际切换，复用v11前向产物如实记录；不是v11自身独立备用包。实际Docker adapter使用只读事实回调，未通过完整manifest门槛CLI，五项能力的切换后业务写入验收仍缺。现有同镜像拒绝项仅阻止改标签，不能以不同digest替代故障针对性证据。下一步首次资格验收应独立收集真实证据后再审核manifest，禁止为启动演练预填passed。
