# 分级备份与恢复

当前策略：关键表每日一次，普通数据每月一次；不接对外失败通知，保留私有失败记录和可恢复版本。正式与测试分别执行，旧归档保留。本说明于2026-11-05按当前安装器与既有目标只读证据校正；本轮没有访问或修改目标环境。

## 周期和范围

- 每日北京时间02:30：关键业务数据，包括采购、收货、库存数量及成本、对账、发票、凭证、账号权限和关联基础资料。新增未知表默认关键；如果关键表引用了月度表，递归提升被引用表到每日关键范围，防止恢复缺关联。
- 每月1日北京时间02:30：完整数据库快照，包含非关键数据，作为完整恢复基线。月度候选为普通通知、通知记录、企微同步日志、美团接口日志、反馈及消息、自动修复运行记录、老板聊天和页面批注。业务操作审计不列入月度候选。
- 所有快照保留完整结构、约束和序列；关键日备份只排除上述非关键表的数据，不删除表或源记录。附件仍完整保存，内容按SHA256去重，数据库和附件清单一起校验。
- 两环境共四个定时实例：production-weekly、production-monthly、uat-weekly、uat-monthly。共享独占锁串行运行，Persistent补跑。实例和目录沿用历史weekly命名，不代表每周执行。安装器必须生成每日timer drop-in；不要直接启用保留历史weekly周期的模板。

策略文件：scripts/ops/backup-table-policy.json。未知新增表默认关键。本轮1.3.3本地合成库158张表，关键恢复核对149张表全部行数与内容SHA，9张月度表保留结构且数据为空；2份合成附件内容一致。证据见docs/qa/evidence/SEARCH-MOUSE-PACKAGE-20261105/RECOVERY/INDEX.json。历史2026-10-27在线154/145表及593附件证明只对应当时版本，不替代本轮证据。

## 位置与保留

- /var/lib/dianjie-backups/production-weekly、production-monthly、uat-weekly、uat-monthly：分环境、分周期归档与状态；同级blobs共享不可变附件内容。
- 关键日归档（weekly目录）保留63天，月度190天，均至少保留最近两份；只到期清理工具自己生成的归档。旧production/uat归档保持原样。共享blobs不自动清理。
- 备份目录700、归档600；独立无登录服务账号执行。环境文件继续root600，新任务只链接原环境文件，不复制到公开位置或镜像。策略/非密配置root:备份组640。
- 磁盘不足1GB拒绝开始新备份，保留上一成功结果；失败15分钟重试、2小时内最多3次。用户不要求外部通知，日志及last-attempt.json保留失败状态，不宣称已经通知人员。
- 用户已明确继续放在现有阿里云服务器，取消本轮NAS/异机复制。当前是阿里云同机备份，不将其称为异机容灾；不创建NAS目录或传输数据到NAS。

## 检查

```sh
systemctl list-timers --all 'dianjie-backup*'
systemctl show dianjie-backup@production-weekly.service -p Result -p ExecMainStatus
python3 /app/dianjie-v4/scripts/ops/backup.py status --config /etc/dianjie/backup-production-weekly.json
```

成功须同时核对任务结果、最新last-attempt为succeeded、归档SHA和全部附件校验。oneshot成功后inactive/dead正常。关键日备份新鲜度上限36小时，月度35天，不能继续用旧的26小时上限判断。四环境任务配置分别为/etc/dianjie/backup-<实例>.json。

## 恢复与回滚

格式2由归档与同级blobs共同组成，只复制tar不能恢复附件。选择一份已校验快照恢复到全新隔离库，不对在线原库drop/clean，不导入本地数据到正式或测试环境。

关键日备份恢复关键业务数据，月度恢复完整数据。不要把不同时间点的关键日备份和月度数据自动拼接成同一个业务库，以免记录/外键不一致。关键日备份恢复中的非关键表为空，这符合其月度保存策略；需要这些历史记录时可另行读取月度隔离副本。

现有恢复命令仍限制localhost:15439及全新dianjie_*_restore_test库、全新附件目录。历史本地证据是144张关键表、153张全表和116附件；本轮当前版本149/158张表与2份合成附件的恢复证据另见上述INDEX，不能混用版本、范围和附件数量。业务恢复后的金额/权限/页面验收和切换另行记录，不能只凭归档存在就称恢复完成。

## 自启动

当前应用交付为Docker镜像；历史pm2-root说明不代表当前运行方式。本地最终镜像、同版本重新部署及完整恢复CLI分别有独立证据，不宣称已在目标执行重启或切换。目标发布时必须通过scripts/ops/install-backup-schedules.cjs安装/更新定时器，并核对 `systemctl cat dianjie-backup@production-weekly.timer` 与UAT对应项包含每日02:30的schedule.conf覆盖，以及配置maximum_age_hours=36。月度仍为每月1日02:30。保留旧Unit和配置供审计，避免同时启用重复任务。
