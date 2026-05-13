#!/bin/bash
# ══════════════════════════════════════
# Nginx 配置部署脚本
# 在服务器上执行：bash /app/dianjie/deploy/setup-nginx.sh
# ══════════════════════════════════════

set -e

echo "📋 备份现有 Nginx 配置..."
cp /etc/nginx/conf.d/dianjie.conf /etc/nginx/conf.d/dianjie.conf.bak 2>/dev/null || true

echo "📝 部署新配置..."
cp /app/dianjie/deploy/nginx.conf /etc/nginx/conf.d/dianjie.conf

echo "🔍 检查配置语法..."
nginx -t

echo "🔄 重载 Nginx..."
nginx -s reload

echo "✅ Nginx 配置更新完毕"
echo ""
echo "验证 gzip："
echo "  curl -s -H 'Accept-Encoding: gzip' -D - http://localhost/ -o /dev/null | grep -i 'content-encoding'"
