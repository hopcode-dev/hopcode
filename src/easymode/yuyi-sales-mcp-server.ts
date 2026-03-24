#!/usr/bin/env npx tsx
/**
 * 渔易销售管理 MCP Server (验证版)
 * 读 Alex 的 SQLite 数据库 + 调外部 MCP 服务获取打卡/拜访数据
 * 提供考勤查询、BD活动、出货统计等工具给小码
 */

import * as readline from 'readline';
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = '/home/alex/coding/yujunshi-analytics/data/yujunshi.db';
const EXT_MCP_URL = 'http://119.29.130.73:8090/mcp'; // 渔军师服务商系统 MCP

let db: any;
try {
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
} catch (e: any) {
  console.error(`[yuyi-mcp] DB open failed: ${e.message}`);
}

// --- External MCP client (for attendance/visit data) ---

let extMcpSessionId: string | null = null;
let extMcpMsgId = 1;

async function extMcpRequest(method: string, params: any = {}): Promise<any> {
  const headers: any = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (extMcpSessionId) headers['mcp-session-id'] = extMcpSessionId;

  const resp = await fetch(EXT_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: extMcpMsgId++, method, params }),
    signal: AbortSignal.timeout(30000),
  });

  const sid = resp.headers.get('mcp-session-id');
  if (sid) extMcpSessionId = sid;

  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    let lastData: string | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) lastData = line.slice(6);
    }
    return lastData ? JSON.parse(lastData) : null;
  }
  return resp.json();
}

async function extCallTool(name: string, args: any = {}): Promise<any> {
  if (!extMcpSessionId) {
    await extMcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'yuyi-sales-mcp', version: '1.0.0' },
    });
    await extMcpRequest('notifications/initialized', {});
  }
  const result = await extMcpRequest('tools/call', { name, arguments: args });
  if (result?.result?.content) {
    const textContent = result.result.content.find((c: any) => c.type === 'text');
    if (textContent) {
      try { return JSON.parse(textContent.text); } catch { return textContent.text; }
    }
  }
  if (result?.error) throw new Error(result.error.message);
  return result;
}

function fmtTime(dateStr: string, isEnd: boolean) {
  if (dateStr.includes(' ')) return dateStr;
  return dateStr + (isEnd ? ' 23:59:59' : ' 00:00:00');
}

function normalizeRecords(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw?.records) return Array.isArray(raw.records) ? raw.records : [];
  if (raw?.data) return Array.isArray(raw.data) ? raw.data : [];
  if (raw?.list) return Array.isArray(raw.list) ? raw.list : [];
  return [];
}

// --- Sales team structure ---

const SALES_TEAMS: Record<string, string[]> = {
  '飞虎队': ['练庆林', '吴健文'],
  '东部战区': ['汤晋庚', '刘家权', '郭湘军', '谈天深'],
  '中部战区': ['梁俊杰', '李冠球', '王浩'],
  '西部战区': ['兰明生', '陈培宏', '黄国毅', '莫熙琳'],
};
const ALL_BD = Object.values(SALES_TEAMS).flat();
const SALES_MANAGER = '马坤';

// --- Helper ---

function today() { return new Date().toISOString().split('T')[0]; }
function formatDate(d: Date) { return d.toISOString().split('T')[0]; }

function queryDB(sql: string, params: any[] = []): any[] {
  if (!db) return [];
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'sales_attendance',
    description: '查询 BD 销售人员的打卡/签到情况。可查今天谁没打卡、某人的打卡记录、团队出勤率等。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD（默认今天）' },
        person: { type: 'string', description: '查某个人（可选）' },
        team: { type: 'string', description: '查某个战区（飞虎队/东部战区/中部战区/西部战区，可选）' },
      },
    },
  },
  {
    name: 'sales_bd_activity',
    description: '查询 BD 的拜访活动记录：去了哪些客户、拜访轨迹、行动里程。可查某人某段时间的拜访详情。',
    inputSchema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'BD 姓名（必填）' },
        start_date: { type: 'string', description: '开始日期 YYYY-MM-DD（默认本月1号）' },
        end_date: { type: 'string', description: '结束日期 YYYY-MM-DD（默认今天）' },
      },
      required: ['person'],
    },
  },
  {
    name: 'sales_shipment_stats',
    description: '出货统计：按时间、产品、区域、经销商、BD 等维度查出货量和趋势。',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['month', 'category', 'province', 'dealer', 'bd'], description: '分组维度' },
        start_date: { type: 'string', description: '开始日期（默认本月1号）' },
        end_date: { type: 'string', description: '结束日期（默认今天）' },
        category: { type: 'string', description: '产品分类过滤（可选）' },
        province: { type: 'string', description: '省份过滤（可选）' },
        bd: { type: 'string', description: 'BD姓名过滤（可选）' },
      },
    },
  },
  {
    name: 'sales_activation_stats',
    description: '设备激活统计：激活量、激活率、续费情况、到期预警。',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['month', 'category', 'province', 'agent', 'bd'], description: '分组维度' },
        start_date: { type: 'string', description: '开始日期（默认本月1号）' },
        end_date: { type: 'string', description: '结束日期（默认今天）' },
        category: { type: 'string', description: '产品品类过滤（可选）' },
      },
    },
  },
  {
    name: 'sales_order_stats',
    description: '订单统计：订单量、金额、完成率、按产品/区域/BD 分析。',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['month', 'category', 'province', 'status', 'bd'], description: '分组维度' },
        start_date: { type: 'string', description: '开始日期' },
        end_date: { type: 'string', description: '结束日期' },
      },
    },
  },
  {
    name: 'sales_team_overview',
    description: '销售团队总览：各战区人员、本月业绩、客户数、拜访数。用于快速了解团队状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sales_dealer_ranking',
    description: '经销商/服务商排名：按出货量、激活量、订单金额排序。可看 Top N 和垫底。',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['shipment', 'activation', 'order_amount'], description: '排名指标（默认 shipment）' },
        limit: { type: 'number', description: '返回条数（默认20）' },
        start_date: { type: 'string', description: '开始日期' },
        end_date: { type: 'string', description: '结束日期' },
      },
    },
  },
  {
    name: 'sales_daily_report',
    description: '生成当日/昨日的关键数据摘要：出货、激活、订单、异常预警。适合每日推送。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD（默认昨天）' },
      },
    },
  },
];

// --- Tool handlers ---

async function handleTool(name: string, args: any): Promise<any> {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  switch (name) {
    case 'sales_attendance': {
      const date = args.date || today();
      const before10 = date + 'T10:00:00';

      // Fetch real interaction records from external MCP for all BD members
      let members = ALL_BD;
      if (args.team && SALES_TEAMS[args.team]) members = SALES_TEAMS[args.team];
      if (args.person) members = members.filter(m => m.includes(args.person));

      const firstSignTime = new Map<string, string>(); // name → earliest create_time

      // Batch fetch (5 at a time like Alex's code)
      for (let i = 0; i < members.length; i += 5) {
        const batch = members.slice(i, i + 5);
        const results = await Promise.all(batch.map(async (name) => {
          try {
            const raw = await extCallTool('sp_interaction_by_user', {
              user_name: name,
              start_time: fmtTime(date, false),
              end_time: fmtTime(date, true),
              limit: 100,
            });
            return { name, records: normalizeRecords(raw) };
          } catch { return { name, records: [] }; }
        }));

        for (const { name, records } of results) {
          for (const r of records) {
            const mcpName = r.sp_user_name || r.user_name || '';
            const matched = members.find(m => mcpName.includes(m));
            if (matched && r.create_time) {
              const prev = firstSignTime.get(matched);
              if (!prev || r.create_time < prev) {
                firstSignTime.set(matched, r.create_time);
              }
            }
          }
        }
      }

      const checkedIn: { name: string; time: string }[] = [];
      const late: { name: string; time: string }[] = [];
      const absent: string[] = [];

      for (const m of members) {
        const t = firstSignTime.get(m);
        if (!t) {
          absent.push(m);
        } else if (t < before10) {
          checkedIn.push({ name: m, time: t.substring(11, 16) });
        } else {
          late.push({ name: m, time: t.substring(11, 16) });
        }
      }

      let result = `📋 ${date} 考勤情况（10:00 截止）\n\n`;
      if (checkedIn.length > 0) {
        result += `✅ 准时 (${checkedIn.length}):\n`;
        for (const c of checkedIn) result += `  ${c.name} ${c.time}\n`;
      }
      if (late.length > 0) {
        result += `⚠️ 迟到 (${late.length}):\n`;
        for (const l of late) result += `  ${l.name} ${l.time}\n`;
      }
      if (absent.length > 0) {
        result += `❌ 未签到 (${absent.length}): ${absent.join('、')}`;
      } else if (checkedIn.length + late.length === members.length) {
        result += `\n全员已签到`;
      }
      return text(result);
    }

    case 'sales_bd_activity': {
      const person = args.person;
      const now = new Date();
      const startDate = args.start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = args.end_date || today();

      // Fetch real interaction records from external MCP
      let records: any[] = [];
      try {
        const raw = await extCallTool('sp_interaction_by_user', {
          user_name: person,
          start_time: fmtTime(startDate, false),
          end_time: fmtTime(endDate, true),
          limit: 500,
        });
        records = normalizeRecords(raw);
      } catch {}

      if (records.length > 0) {
        // Classify records
        const byDate = new Map<string, any[]>();
        let visits = 0, checkins = 0, leads = 0;
        const customers = new Set<string>();

        for (const r of records) {
          const d = (r.create_time || '').substring(0, 10);
          if (!d) continue;
          if (!byDate.has(d)) byDate.set(d, []);
          byDate.get(d)!.push(r);

          const t = String(r.type || '');
          const td = String(r.type_desc || '');
          if (t === '2' || td.includes('打卡')) checkins++;
          else if (t === '4' || td.includes('线索')) leads++;
          else visits++;

          const cust = r.customer_name || r.sp_name || '';
          if (cust) customers.add(cust);
        }

        let result = `📍 ${person} 的活动记录 (${startDate} ~ ${endDate})\n`;
        result += `拜访 ${visits} 次 | 打卡 ${checkins} 次 | 线索 ${leads} 条 | 客户 ${customers.size} 家\n\n`;

        // Show last 10 days detail
        const dates = Array.from(byDate.keys()).sort().slice(-10);
        for (const date of dates) {
          const recs = byDate.get(date)!;
          result += `${date} (${recs.length}条):\n`;
          for (const r of recs.slice(0, 5)) {
            const time = (r.create_time || '').substring(11, 16);
            const type = r.type_desc || (r.type === '1' ? '拜访' : r.type === '2' ? '打卡' : '线索');
            const cust = r.customer_name || r.sp_name || '';
            const addr = r.address || '';
            const issue = r.current_issue ? ` | ${r.current_issue.substring(0, 40)}` : '';
            result += `  ${time} [${type}] ${cust} ${addr}${issue}\n`;
          }
          if (recs.length > 5) result += `  ...还有 ${recs.length - 5} 条\n`;
        }

        result += `\n共 ${records.length} 条记录，${byDate.size} 天有活动`;
        return text(result);
      }

      // Fallback: check shipment records
      const shipments = queryDB(
        `SELECT "出库时间" as time, "出库服务商名称" as dealer FROM shipment WHERE "负责BD" LIKE ? AND date("出库时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? ORDER BY "出库时间"`,
        [`%${person}%`, startDate, endDate]
      );

      let result = `📍 ${person} 的活动记录 (${startDate} ~ ${endDate})\n\n`;
      if (shipments.length > 0) {
        const dealers = new Set(shipments.map((s: any) => s.dealer).filter(Boolean));
        result += `MCP 无拜访记录，出货记录: ${shipments.length} 笔\n`;
        result += `涉及经销商: ${Array.from(dealers).join('、')}\n`;
      } else {
        result += `暂无拜访或出货记录`;
      }
      return text(result);
    }

    case 'sales_shipment_stats': {
      const now = new Date();
      const startDate = args.start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = args.end_date || today();
      const groupBy = args.group_by || 'month';

      let where = `WHERE date("出库时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`;
      const params: any[] = [startDate, endDate];

      if (args.category) { where += ` AND "产品分类" LIKE ?`; params.push(`%${args.category}%`); }
      if (args.province) { where += ` AND "省" LIKE ?`; params.push(`%${args.province}%`); }
      if (args.bd) { where += ` AND "负责BD" LIKE ?`; params.push(`%${args.bd}%`); }

      const groupCol: Record<string, string> = {
        month: `strftime('%Y-%m', "出库时间"/1000, 'unixepoch', 'localtime')`,
        category: `"产品分类"`,
        province: `"省"`,
        dealer: `"出库服务商名称"`,
        bd: `"负责BD"`,
      };
      const col = groupCol[groupBy] || groupCol.month;

      const rows = queryDB(
        `SELECT ${col} as grp, COUNT(*) as cnt FROM shipment ${where} GROUP BY grp ORDER BY cnt DESC LIMIT 30`,
        params
      );

      const total = queryDB(`SELECT COUNT(*) as cnt FROM shipment ${where}`, params)[0]?.cnt || 0;

      let result = `📦 出货统计 (${startDate} ~ ${endDate})\n总计: ${total} 笔\n\n`;
      result += `按${groupBy}分组:\n`;
      for (const r of rows) {
        result += `  ${r.grp || '未知'}: ${r.cnt}\n`;
      }
      return text(result);
    }

    case 'sales_activation_stats': {
      const now = new Date();
      const startDate = args.start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = args.end_date || today();
      const groupBy = args.group_by || 'month';

      const groupCol: Record<string, string> = {
        month: `strftime('%Y-%m', "设备激活时间"/1000, 'unixepoch', 'localtime')`,
        category: `"产品品类"`,
        province: `"设备代理商省份"`,
        agent: `"设备代理商名称"`,
        bd: `"负责BD"`,
      };
      const col = groupCol[groupBy] || groupCol.month;

      const rows = queryDB(
        `SELECT ${col} as grp, COUNT(*) as cnt FROM activation WHERE date("设备激活时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? GROUP BY grp ORDER BY cnt DESC LIMIT 30`,
        [startDate, endDate]
      );

      const total = rows.reduce((s: number, r: any) => s + r.cnt, 0);
      let result = `📱 激活统计 (${startDate} ~ ${endDate})\n总计: ${total} 台\n\n`;
      for (const r of rows) {
        result += `  ${r.grp || '未知'}: ${r.cnt}\n`;
      }

      // Expiry alert
      const expiring = queryDB(
        `SELECT COUNT(*) as cnt FROM activation WHERE "年费到期时间" IS NOT NULL AND date("年费到期时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND date(?, '+30 days')`,
        [today(), today()]
      )[0]?.cnt || 0;
      if (expiring > 0) result += `\n⚠️ 30天内到期设备: ${expiring} 台`;

      return text(result);
    }

    case 'sales_order_stats': {
      const now = new Date();
      const startDate = args.start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = args.end_date || today();
      const groupBy = args.group_by || 'month';

      const groupCol: Record<string, string> = {
        month: `strftime('%Y-%m', "发货日期"/1000, 'unixepoch', 'localtime')`,
        category: `"产品名称"`,
        province: `"省份"`,
        status: `"订单状态"`,
        bd: `"申请人"`,
      };
      const col = groupCol[groupBy] || groupCol.month;

      const rows = queryDB(
        `SELECT ${col} as grp, COUNT(*) as cnt, SUM(CAST("订单金额" AS REAL)) as amount FROM orders WHERE date("发货日期"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? GROUP BY grp ORDER BY cnt DESC LIMIT 30`,
        [startDate, endDate]
      );

      let result = `📋 订单统计 (${startDate} ~ ${endDate})\n\n`;
      for (const r of rows) {
        const amt = r.amount ? ` ¥${Math.round(r.amount).toLocaleString()}` : '';
        result += `  ${r.grp || '未知'}: ${r.cnt} 笔${amt}\n`;
      }
      return text(result);
    }

    case 'sales_team_overview': {
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = today();

      let result = `👥 销售团队总览 (${monthStart} ~ ${endDate})\n\n`;

      for (const [team, members] of Object.entries(SALES_TEAMS)) {
        const bdList = members.map(m => `%${m}%`);
        const placeholders = bdList.map(() => `"负责BD" LIKE ?`).join(' OR ');

        const shipCount = queryDB(
          `SELECT COUNT(*) as cnt FROM shipment WHERE (${placeholders}) AND date("出库时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
          [...bdList, monthStart, endDate]
        )[0]?.cnt || 0;

        result += `${team} (${members.join('、')}):\n  本月出货: ${shipCount} 笔\n\n`;
      }

      // Total
      const totalShip = queryDB(
        `SELECT COUNT(*) as cnt FROM shipment WHERE date("出库时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
        [monthStart, endDate]
      )[0]?.cnt || 0;
      result += `全公司本月出货: ${totalShip} 笔`;

      return text(result);
    }

    case 'sales_dealer_ranking': {
      const metric = args.metric || 'shipment';
      const limit = args.limit || 20;
      const now = new Date();
      const startDate = args.start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = args.end_date || today();

      let sql = '';
      if (metric === 'shipment') {
        sql = `SELECT "出库服务商名称" as name, COUNT(*) as value FROM shipment WHERE date("出库时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? AND "出库服务商名称" IS NOT NULL GROUP BY name ORDER BY value DESC LIMIT ?`;
      } else if (metric === 'activation') {
        sql = `SELECT "设备代理商名称" as name, COUNT(*) as value FROM activation WHERE date("设备激活时间"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? AND "设备代理商名称" IS NOT NULL GROUP BY name ORDER BY value DESC LIMIT ?`;
      } else {
        sql = `SELECT "申请人" as name, SUM(CAST("订单金额" AS REAL)) as value FROM orders WHERE date("发货日期"/1000, 'unixepoch', 'localtime') BETWEEN ? AND ? GROUP BY name ORDER BY value DESC LIMIT ?`;
      }

      const rows = queryDB(sql, [startDate, endDate, limit]);
      const metricLabel = { shipment: '出货量', activation: '激活量', order_amount: '订单金额' }[metric] || metric;

      let result = `🏆 ${metricLabel}排名 (${startDate} ~ ${endDate})\n\n`;
      rows.forEach((r: any, i: number) => {
        const val = metric === 'order_amount' ? `¥${Math.round(r.value).toLocaleString()}` : r.value;
        result += `${i + 1}. ${r.name}: ${val}\n`;
      });
      return text(result);
    }

    case 'sales_daily_report': {
      const d = args.date || formatDate(new Date(Date.now() - 86400000)); // default yesterday

      const shipCount = queryDB(
        `SELECT COUNT(*) as cnt FROM shipment WHERE date("出库时间"/1000, 'unixepoch', 'localtime') = ?`, [d]
      )[0]?.cnt || 0;

      const actCount = queryDB(
        `SELECT COUNT(*) as cnt FROM activation WHERE date("设备激活时间"/1000, 'unixepoch', 'localtime') = ?`, [d]
      )[0]?.cnt || 0;

      const orderRows = queryDB(
        `SELECT COUNT(*) as cnt, SUM(CAST("订单金额" AS REAL)) as amount FROM orders WHERE date("发货日期"/1000, 'unixepoch', 'localtime') = ?`, [d]
      )[0] || { cnt: 0, amount: 0 };

      // Returns
      const returns = queryDB(
        `SELECT COUNT(*) as cnt FROM shipment WHERE "是否发生退货" = '是' AND date("出库时间"/1000, 'unixepoch', 'localtime') = ?`, [d]
      )[0]?.cnt || 0;

      const returnRate = shipCount > 0 ? (returns / shipCount * 100).toFixed(1) : '0';

      let result = `📊 ${d} 日报\n\n`;
      result += `出货: ${shipCount} 笔\n`;
      result += `激活: ${actCount} 台\n`;
      result += `订单: ${orderRows.cnt} 笔 ¥${Math.round(orderRows.amount || 0).toLocaleString()}\n`;
      result += `退货率: ${returnRate}%${parseFloat(returnRate) > 5 ? ' ⚠️ 超阈值' : ''}\n`;

      // Top BD
      const topBD = queryDB(
        `SELECT "负责BD" as bd, COUNT(*) as cnt FROM shipment WHERE date("出库时间"/1000, 'unixepoch', 'localtime') = ? AND "负责BD" IS NOT NULL GROUP BY bd ORDER BY cnt DESC LIMIT 5`, [d]
      );
      if (topBD.length > 0) {
        result += `\nTop BD:\n`;
        topBD.forEach((r: any) => { result += `  ${r.bd}: ${r.cnt} 笔\n`; });
      }

      return text(result);
    }

    default:
      return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
  }
}

// --- JSON-RPC stdio ---

function sendResponse(id: any, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: any, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleRequest(req: any) {
  switch (req.method) {
    case 'initialize':
      sendResponse(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'yuyi-sales', version: '1.0.0' },
      });
      break;
    case 'notifications/initialized': break;
    case 'tools/list':
      sendResponse(req.id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const { name, arguments: args } = req.params;
      try {
        sendResponse(req.id, await handleTool(name, args || {}));
      } catch (e: any) {
        sendResponse(req.id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
      break;
    }
    default:
      if (req.id) sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { try { handleRequest(JSON.parse(line)); } catch {} });
