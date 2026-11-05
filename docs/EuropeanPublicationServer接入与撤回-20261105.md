# European Publication Server 入口与专利原文区域

本次在网页回答勾选专利时，将“专利原文与官方入口”区域显示在回答正文前，逐一列出正文里的公开号。来源编号与 URL 编号冲突时，不再将该来源误配给目标专利。原始引用仍保留，用户可直接打开目标公开号核对描述。

## 链接规则

- CN 等编号分别提供按公开号打开的 Google Patents 页面，以及按编号检索的备用入口；入口本身不代表已核实文献存在或技术描述正确。
- EP 编号额外提供 European Publication Server PDF 与 HTML 入口。
- EPO REST 1.2 路径采用 `EP + 七位公开号 + NW + 文献种类`，例如 `EP0816797NWA3/document.pdf` 和 `EP0816797NWB1/document.pdf`。不将 CN 编号推测成 EP 同族编号。
- 本次服务器实测上述 A3、B1 两个 REST 入口均返回 `206 application/pdf`，文件前缀为 `%PDF`。旧的 `/pdf-document?cc=...` 链接在此次实测中返回 HTML，故采用官方 REST 路径。
- 首页 HTML 使用 `Cache-Control: no-cache`，重新加载时检查最新入口；资源文件仍使用带哈希的文件名。已经打开的页面需要刷新后使用新界面。

官方参考：

- [EPO Publication Server 服务说明](https://www.epo.org/en/searching-for-patents/data/web-services/publication-server)
- [REST 服务参考文档](https://data.epo.org/publication-server/doc/EPS%20REST%20services.pdf)

## 撤回

本次仍只部署前端和对应站点配置，备份三个站点发布前配置及旧前端目录：

```text
/var/lib/cst-account-editions/patent-eps-20261105/
```

检查本次恢复条件：

```sh
sudo python3 /var/lib/cst-account-editions/patent-eps-20261105/rollback.py --check
```

只撤回这次独立专利原文区域和 EPO 入口，恢复至上一版专利编号链接展示：

```sh
sudo python3 /var/lib/cst-account-editions/patent-eps-20261105/rollback.py --apply
```

若要连同上一次专利编号链接展示一起撤回，在上述恢复成功后再执行：

```sh
sudo python3 /var/lib/cst-account-editions/patent-links-20261105/rollback.py --check
sudo python3 /var/lib/cst-account-editions/patent-links-20261105/rollback.py --apply
```

两级恢复均保留账号、对话、积分、后端和数据表生成修复。配置被其他运维操作改动后，脚本会拒绝自动覆盖，须先核对差异。
