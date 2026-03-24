#!/usr/bin/env node
/**
 * Tesla MCP Server — stdio transport
 * Tools: check_battery, wake_vehicle
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const TOKEN_FILE = path.join(DIR, 'tokens.json');
const ENV_FILE = path.join(DIR, '.env');
const API_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';

// Load .env
const envText = fs.readFileSync(ENV_FILE, 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

function loadTokens() {
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

function saveTokens(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

async function ensureToken() {
  const tokens = loadTokens();
  const obtained = tokens.obtained_at || 0;
  const expiresIn = tokens.expires_in || 3600;
  const now = Math.floor(Date.now() / 1000);

  if (now < obtained + expiresIn - 300) {
    return tokens.access_token;
  }

  // Refresh
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.TESLA_CLIENT_ID,
      client_secret: env.TESLA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const newTokens = await resp.json();
  newTokens.obtained_at = now;
  saveTokens(newTokens);
  return newTokens.access_token;
}

async function apiGet(path, token) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tesla API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function checkBattery() {
  const token = await ensureToken();
  const { response: vehicles } = await apiGet('/api/1/vehicles', token);

  if (!vehicles?.length) return { error: 'No vehicles found' };

  const v = vehicles[0];
  if (v.state === 'asleep' || v.state === 'offline') {
    return {
      vehicle: v.display_name || 'Tesla',
      state: v.state,
      note: 'Vehicle is asleep/offline, cannot get charge state. Use wake_vehicle first.',
    };
  }

  const { response } = await apiGet(
    `/api/1/vehicles/${v.id}/vehicle_data?endpoints=charge_state`,
    token,
  );
  const cs = response?.charge_state;
  if (!cs) return { vehicle: v.display_name, error: 'No charge_state in response' };

  return {
    vehicle: v.display_name || 'Tesla',
    battery_level: cs.battery_level,
    charge_limit: cs.charge_limit_soc,
    charging_state: cs.charging_state,
    range_km: Math.round(cs.battery_range * 1.60934 * 10) / 10,
    minutes_to_full: cs.minutes_to_full_charge || null,
    charger_power_kw: cs.charger_power || null,
  };
}

async function wakeVehicle() {
  const token = await ensureToken();
  const { response: vehicles } = await apiGet('/api/1/vehicles', token);
  if (!vehicles?.length) return { error: 'No vehicles found' };

  const v = vehicles[0];
  const resp = await fetch(`${API_BASE}/api/1/vehicles/${v.id}/wake_up`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  return {
    vehicle: v.display_name || 'Tesla',
    state: data.response?.state || 'unknown',
  };
}

// MCP Server
const server = new Server(
  { name: 'tesla', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'check_battery',
      description:
        'Check Tesla vehicle battery level, charging state, and range. Returns battery_level (%), charging_state, range_km, etc.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'wake_vehicle',
      description:
        'Wake up the Tesla vehicle if it is asleep. Call this before check_battery if the vehicle is asleep.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    let result;
    switch (request.params.name) {
      case 'check_battery':
        result = await checkBattery();
        break;
      case 'wake_vehicle':
        result = await wakeVehicle();
        break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
          isError: true,
        };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
