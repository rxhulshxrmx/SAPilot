const vscode = require('vscode');
const { transportForDeployment, endpointForDeployment, buildRequest, parseResponse } = require('./model-transports');

const VENDOR = 'sap-ai-core';
const CLIENT_ID = 'sap-ai-core-chat.clientId';
const CLIENT_SECRET = 'sap-ai-core-chat.clientSecret';
const AUTH_URL = 'sap-ai-core-chat.authUrl';
const API_URL = 'sap-ai-core-chat.apiUrl';
const RESOURCE_GROUP = 'sap-ai-core-chat.resourceGroup';
const DEFAULT_API_VERSION = '2024-10-21';
const WELCOME_SHOWN_KEY = 'sap-ai-core-chat.welcomeShown';
const WALKTHROUGH_ID = 'sharma-so.sapilot#sapAiCoreGettingStarted';

class SapAiCoreProvider {
  constructor(context) {
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this.emitter.event;
    this.tokenCache = undefined;
    this.modelCache = undefined;
    this.modelCacheAt = 0;
  }

  async provideLanguageModelChatInformation(options, token) {
    const config = await getConnection(this.context);
    if (!config.clientId || !config.clientSecret || !config.authUrl || !config.apiUrl) return [];
    try {
      const models = await this.discoverModels(token);
      return models.map(model => ({
        id: model.id,
        name: model.name,
        family: model.modelName,
        version: model.version || '1.0.0',
        maxInputTokens: model.contextLength || 16000,
        maxOutputTokens: 4000,
        tooltip: `SAP AI Core · ${model.label}`,
        detail: `Resource group: ${model.resourceGroup}`,
        capabilities: { toolCalling: model.toolCalling, imageInput: false }
      }));
    } catch (error) {
      if (options && options.silent) return [];
      throw error;
    }
  }

  async provideTokenCount(_model, value) {
    const text = typeof value === 'string'
      ? value
      : (value.content || []).map(part => part.value || '').join('');
    return Math.ceil(text.length / 4);
  }

  async provideLanguageModelChatResponse(modelInfo, messages, options, progress, cancellationToken) {
    const models = await this.discoverModels(cancellationToken);
    const model = models.find(candidate => candidate.id === modelInfo.id);
    if (!model) throw new Error('This SAP AI Core deployment is no longer available. Refresh the model picker.');

    const abortController = new AbortController();
    const cancellation = bindCancellation(cancellationToken, abortController);
    try {
      const tools = model.toolCalling ? options.tools || [] : [];
      await this.sendChatRequest(model, convertMessages(messages), tools, progress, abortController.signal);
    } finally {
      cancellation.dispose();
    }
  }

  async testConnection(model, signal) {
    let reply = '';
    await this.sendChatRequest(model, [{ role: 'user', content: 'Reply with the single word: OK' }], [], {
      report: part => {
        if (part instanceof vscode.LanguageModelTextPart) reply += part.value;
      }
    }, signal);
    return reply.trim();
  }

  async sendChatRequest(model, messages, tools, progress, signal) {
    const config = await getConnection(this.context);
    const accessToken = await this.getAccessToken(config);
    const request = buildRequest(model.transport, model.modelName, messages, tools);
    const response = await fetch(model.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'AI-Resource-Group': config.resourceGroup,
        'Content-Type': 'application/json',
        Accept: request.streaming ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(request.body),
      signal
    });
    if (!response.ok) throw new Error(httpErrorMessage(response, 'SAP AI Core'));
    if (request.streaming) {
      if (!response.body) throw new Error('SAP AI Core returned an empty response.');
      await streamChatCompletion(response.body, progress, signal);
      return;
    }
    const result = parseResponse(model.transport, await response.json());
    if (result.text) progress.report(new vscode.LanguageModelTextPart(result.text));
    for (const call of result.toolCalls) progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.input));
  }

  async discoverModels(cancellationToken) {
    if (this.modelCache && Date.now() - this.modelCacheAt < 60_000) return this.modelCache;
    const config = await getConnection(this.context);
    if (!config.clientId || !config.clientSecret || !config.authUrl || !config.apiUrl) return [];
    const apiUrl = assertSapHttpsUrl(config.apiUrl, 'AI Core base URL');
    const token = await this.getAccessToken(config, cancellationToken);
    const controller = new AbortController();
    const cancellation = bindCancellation(cancellationToken, controller);
    try {
      const headers = { Authorization: `Bearer ${token}`, 'AI-Resource-Group': config.resourceGroup };
      const [response, modelCatalog] = await Promise.all([
        fetch(`${apiUrl}/v2/lm/deployments?$top=10000&$skip=0`, {
          redirect: 'error', headers, signal: controller.signal
        }),
        fetchFoundationModelCatalog(apiUrl, headers, controller.signal)
      ]);
      if (!response.ok) throw new Error(httpErrorMessage(response, 'SAP AI Core'));
      const payload = await response.json();
      this.modelCache = parseDeployments(payload, apiUrl, config.resourceGroup).map(model => ({
        ...model,
        contextLength: findContextLength(model, modelCatalog)
      }));
      this.modelCacheAt = Date.now();
      return this.modelCache;
    } finally {
      if (cancellation) cancellation.dispose();
    }
  }

  async getAccessToken(config, cancellationToken) {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) return this.tokenCache.value;
    const { clientId, clientSecret } = config;
    let authUrl = assertSapHttpsUrl(config.authUrl, 'Auth URL');
    if (!authUrl.endsWith('/oauth/token')) authUrl += '/oauth/token';
    const abortController = new AbortController();
    const cancellation = bindCancellation(cancellationToken, abortController);
    try {
      const response = await fetch(`${authUrl}?grant_type=client_credentials`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        },
        signal: abortController.signal
      });
      if (!response.ok) throw new Error(httpErrorMessage(response, 'SAP sign-in'));
      const token = await response.json();
      if (!token.access_token) throw new Error('SAP OAuth response did not contain an access_token.');
      this.tokenCache = {
        value: token.access_token,
        expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000
      };
      return this.tokenCache.value;
    } finally {
      if (cancellation) cancellation.dispose();
    }
  }
}

async function fetchFoundationModelCatalog(apiUrl, headers, signal) {
  try {
    const response = await fetch(`${apiUrl}/v2/lm/scenarios/foundation-models/models`, {
      redirect: 'error', headers, signal
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return payload && Array.isArray(payload.resources) ? payload.resources : [];
  } catch {
    // Model discovery is supplemental: keep deployments available if this
    // endpoint is unavailable or the service key cannot access it.
    return [];
  }
}

function findContextLength(deployment, catalog) {
  const entry = catalog.find(model =>
    String(model.model || model.name || '').toLowerCase() === deployment.modelName.toLowerCase());
  if (!entry || !Array.isArray(entry.versions)) return undefined;
  const versions = entry.versions;
  const deploymentVersion = String(deployment.version || '').toLowerCase();
  const deployedVersion = deploymentVersion && deploymentVersion !== 'latest'
    ? versions.find(version => String(version.name || '').toLowerCase() === deploymentVersion)
    : undefined;
  const selectedVersion = deployedVersion || ((!deploymentVersion || deploymentVersion === 'latest')
    ? versions.find(version => version.isLatest) || (versions.length === 1 ? versions[0] : undefined)
    : undefined);
  const contextLength = Number(selectedVersion && selectedVersion.contextLength);
  return Number.isSafeInteger(contextLength) && contextLength > 0 ? contextLength : undefined;
}

function bindCancellation(source, controller) {
  if (!source) return undefined;
  if (typeof source.onCancellationRequested === 'function') {
    return source.onCancellationRequested(() => controller.abort());
  }
  if (typeof source.addEventListener === 'function') {
    const abort = () => controller.abort();
    if (source.aborted) controller.abort();
    else source.addEventListener('abort', abort, { once: true });
    return { dispose: () => source.removeEventListener('abort', abort) };
  }
  return undefined;
}

function httpErrorMessage(response, service) {
  const status = response.status;
  if (status === 502 || status === 503 || status === 504) {
    return `${service} is temporarily unavailable (HTTP ${status}). Try again in a moment.`;
  }
  if (service === 'SAP sign-in' && (status === 400 || status === 401 || status === 403)) {
    return 'SAP could not sign you in. Check your Client ID, Client secret, and Auth URL.';
  }
  if (status === 401 || status === 403) {
    return 'SAP denied access. Check your resource group and account permissions.';
  }
  return `${service} could not complete the request (HTTP ${status}). Check your connection details and try again.`;
}

function parseDeployments(payload, apiUrl, resourceGroup) {
  const resources = payload && Array.isArray(payload.resources) ? payload.resources : [];
  return resources.flatMap(resource => {
    if (!resource || resource.targetStatus !== 'RUNNING' || !resource.id) return [];
    const backendModel = resource.details && resource.details.resources && resource.details.resources.backend_details && resource.details.resources.backend_details.model;
    const modelObject = backendModel || resource.model;
    const modelName = typeof modelObject === 'string' ? modelObject : modelObject && modelObject.name || resource.modelName;
    if (!modelName) return [];
    const transport = transportForDeployment(resource.executableId, modelName);
    if (transport === 'unsupported') return [];
    const label = modelObject && typeof modelObject === 'object' && modelObject.version
      ? `${modelName}:${modelObject.version}`
      : modelName;
    const baseEndpoint = resource.deploymentUrl || `${apiUrl}/v2/inference/deployments/${encodeURIComponent(resource.id)}`;
    const endpoint = endpointForDeployment(baseEndpoint, transport, resource.executableId, modelName, DEFAULT_API_VERSION);
    const url = new URL(endpoint);
    if (!isSapHttpsUrl(url.toString())) return [];
    if ((resource.executableId || '').toLowerCase() === 'azure-openai' && !url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', DEFAULT_API_VERSION);
    }
    return [{
      id: `sap-${resource.id}`,
      deploymentId: resource.id,
      name: label,
      label,
      modelName,
      version: modelObject && typeof modelObject === 'object' && modelObject.version,
      executableId: resource.executableId,
      transport,
      endpoint: url.toString(),
      resourceGroup,
      toolCalling: !modelName.toLowerCase().includes('sonar')
    }];
  }).sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeBaseUrl(value) {
  let url = String(value).trim().replace(/^['"]|['"]$/g, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  url = url.replace(/\/oauth\/token$/i, '').replace(/\/v2$/i, '');
  return url;
}

function assertSapHttpsUrl(value, label) {
  const normalized = normalizeBaseUrl(value);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid SAP AI Core URL.`);
  }
  if (!isSapHttpsUrl(url.toString())) {
    throw new Error(`${label} must use HTTPS and a SAP host ending in .hana.ondemand.com.`);
  }
  return url.toString().replace(/\/$/, '');
}

function isSapHttpsUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password &&
      (hostname === 'hana.ondemand.com' || hostname.endsWith('.hana.ondemand.com'));
  } catch {
    return false;
  }
}

function convertMessages(messages) {
  const output = [];
  for (const message of messages) {
    const role = message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
    let content = '';
    const toolCalls = [];
    const toolResults = [];
    for (const part of message.content || []) {
      if (part instanceof vscode.LanguageModelTextPart) content += part.value;
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input) }
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: (part.content || []).map(value => value instanceof vscode.LanguageModelTextPart ? value.value : JSON.stringify(value)).join('')
        });
      }
    }
    if (content || toolCalls.length || !toolResults.length) {
      const converted = { role, content: content || null };
      if (toolCalls.length) converted.tool_calls = toolCalls;
      output.push(converted);
    }
    output.push(...toolResults);
  }
  return output;
}

async function streamChatCompletion(stream, progress, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const calls = new Map();
  let done = false;
  while (!done) {
    if (signal.aborted) throw new Error('Request cancelled.');
    const chunk = await reader.read();
    pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      const delta = event.choices && event.choices[0] && event.choices[0].delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) progress.report(new vscode.LanguageModelTextPart(delta.content));
      for (const call of delta.tool_calls || []) {
        const accumulated = calls.get(call.index) || { id: '', name: '', arguments: '' };
        if (call.id) accumulated.id += call.id;
        if (call.function && call.function.name) accumulated.name += call.function.name;
        if (call.function && call.function.arguments) accumulated.arguments += call.function.arguments;
        calls.set(call.index, accumulated);
      }
    }
    done = chunk.done;
  }
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    let input;
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error(`SAP AI Core returned invalid arguments for tool ${call.name}.`);
    }
    progress.report(new vscode.LanguageModelToolCallPart(call.id || `sap-tool-${index}`, call.name, input));
  }
}

async function getConnection(context) {
  return {
    clientId: context.globalState.get(CLIENT_ID, ''),
    clientSecret: await context.secrets.get(CLIENT_SECRET) || '',
    apiUrl: context.globalState.get(API_URL, ''),
    authUrl: context.globalState.get(AUTH_URL, ''),
    resourceGroup: context.globalState.get(RESOURCE_GROUP, 'default')
  };
}

class CredentialsViewProvider {
  constructor(context, provider, statusBarItem) {
    this.context = context;
    this.provider = provider;
    this.statusBarItem = statusBarItem;
  }

  setStatus(text, tooltip) {
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
  }

  openPanel() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sap-ai-core-chat.connection',
      'Connect SAP AI Core',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.webview.html = credentialsHtml(panel.webview);
    this.bindMessages(panel.webview);
  }

  bindMessages(webview) {
    webview.onDidReceiveMessage(async message => {
      if (message.type === 'ready') {
        await this.sendConfig(webview);
        webview.postMessage({ type: 'status', state: 'idle', text: '' });
      } else if (message.type === 'save') {
        await this.save(webview, message.value || {});
      } else if (message.type === 'clear') {
        await this.clear(webview);
      }
    }, undefined, this.context.subscriptions);
  }

  async sendConfig(webview) {
    const value = await getConnection(this.context);
    const configured = value.clientId && value.clientSecret && value.apiUrl && value.authUrl;
    this.setStatus(
      configured ? '$(check) SAPilot' : '$(plug) SAPilot',
      configured ? 'SAPilot connection details are saved. Click to manage.' : 'Click to connect SAPilot to SAP AI Core.'
    );
    webview.postMessage({
      type: 'config',
      value: {
        clientId: value.clientId,
        apiUrl: value.apiUrl,
        authUrl: value.authUrl,
        resourceGroup: value.resourceGroup,
        hasSecret: Boolean(value.clientSecret)
      }
    });
  }

  async save(webview, value) {
    const config = {
      clientId: String(value.clientId || '').trim(),
      apiUrl: String(value.apiUrl || '').trim(),
      authUrl: String(value.authUrl || '').trim(),
      resourceGroup: String(value.resourceGroup || '').trim() || 'default'
    };
    const newSecret = String(value.clientSecret || '').trim();
    const currentSecret = await this.context.secrets.get(CLIENT_SECRET);
    if (!config.clientId || !config.apiUrl || !config.authUrl || (!newSecret && !currentSecret)) {
      webview.postMessage({ type: 'status', state: 'error', text: 'Fill in Client ID, Client secret, AI Core base URL, and Auth URL.' });
      return;
    }
    try {
      config.apiUrl = assertSapHttpsUrl(config.apiUrl, 'AI Core base URL');
      config.authUrl = assertSapHttpsUrl(config.authUrl, 'Auth URL');
    } catch (error) {
      webview.postMessage({ type: 'status', state: 'error', text: error.message });
      return;
    }
    await this.context.globalState.update(CLIENT_ID, config.clientId);
    await this.context.globalState.update(API_URL, config.apiUrl);
    await this.context.globalState.update(AUTH_URL, config.authUrl);
    await this.context.globalState.update(RESOURCE_GROUP, config.resourceGroup);
    if (newSecret) await this.context.secrets.store(CLIENT_SECRET, newSecret);
    this.provider.tokenCache = undefined;
    this.provider.modelCache = undefined;
    this.provider.emitter.fire();
    await this.sendConfig(webview);
    await this.refreshStatus(webview);
  }

  async refreshStatus(webview) {
    const config = await getConnection(this.context);
    if (!config.clientId || !config.clientSecret || !config.apiUrl || !config.authUrl) {
      webview.postMessage({ type: 'status', state: 'error', text: 'Enter all credentials first.' });
      return;
    }
    webview.postMessage({ type: 'status', state: 'testing', text: 'Testing…' });
    this.setStatus('$(sync) SAPilot', 'SAPilot is checking the SAP AI Core connection.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      this.provider.modelCache = undefined;
      const models = await this.provider.discoverModels(controller.signal);
      if (!models.length) throw new Error(`Credentials are valid, but no supported chat deployments were found in resource group "${config.resourceGroup}".`);
      const reply = await this.provider.testConnection(models[0], controller.signal);
      const result = reply
        ? 'Connected and tested successfully. Open VS Code Chat and select an SAP AI Core model.'
        : 'Connected, but the reply was empty. Open VS Code Chat and select an SAP AI Core model.';
      this.setStatus('$(check) SAPilot', result);
      webview.postMessage({ type: 'status', state: 'ok', text: result });
    } catch (error) {
      const detail = controller.signal.aborted
        ? 'SAP took too long to respond. Your details are saved; try again in a moment.'
        : error instanceof Error && error.message === 'fetch failed'
          ? 'Could not reach SAP. Check your internet connection and the URLs, then try again.'
          : error instanceof Error ? error.message : String(error);
      const message = controller.signal.aborted ? detail : `Your details are saved. ${detail}`;
      this.setStatus('$(warning) SAPilot', message);
      webview.postMessage({ type: 'status', state: 'error', text: message });
    } finally {
      clearTimeout(timeout);
    }
  }

  async clear(webview) {
    const answer = await vscode.window.showWarningMessage('Remove saved SAP AI Core credentials from this VS Code profile?', 'Remove');
    if (answer !== 'Remove') return;
    await this.context.secrets.delete(CLIENT_SECRET);
    for (const key of [CLIENT_ID, API_URL, AUTH_URL, RESOURCE_GROUP]) await this.context.globalState.update(key, undefined);
    this.provider.tokenCache = undefined;
    this.provider.modelCache = undefined;
    this.provider.emitter.fire();
    await this.sendConfig(webview);
    webview.postMessage({ type: 'status', state: 'idle', text: '' });
  }
}

function credentialsHtml(webview) {
  const nonce = require('node:crypto').randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { max-width: 720px; margin: 0 auto; padding: 36px 28px 48px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); background: var(--vscode-editor-background); }
  h2 { font-size: 1.4em; font-weight: 600; letter-spacing: -.01em; margin: 0 0 8px; }
  .intro { color: var(--vscode-descriptionForeground); margin: 0 0 22px; line-height: 1.5; }
  .field { display: flex; flex-direction: column; gap: 6px; margin: 0 0 15px; }
  label { font-size: .9em; color: var(--vscode-foreground); }
  input { width: 100%; min-height: 31px; padding: 6px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 5px; font: inherit; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: .8; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button { font: inherit; cursor: pointer; }
  #testConnectionBtn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; margin-top: 2px; padding: 7px 16px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; font: inherit; transition: background-color .12s ease; }
  #testConnectionBtn:hover { background: var(--vscode-button-hoverBackground); }
  #testConnectionBtn:disabled { opacity: .55; cursor: default; }
  #connectionStatus { min-height: 1.4em; margin: 10px 0 0; font-size: .85em; line-height: 1.45; overflow-wrap: anywhere; }
  #connectionStatus.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)); }
  #connectionStatus.error { color: var(--vscode-editorError-foreground, var(--vscode-errorForeground)); }
  #connectionStatus.testing { color: var(--vscode-descriptionForeground); }
  #clear { display: inline-flex; align-items: center; min-height: 27px; margin-top: 13px; padding: 4px 9px; color: var(--vscode-errorForeground); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 5px; font: inherit; font-size: .82em; }
  #clear:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  #clear[hidden] { display: none; }
  .hint { margin-top: 1px; color: var(--vscode-descriptionForeground); font-size: .82em; }
  .success-note { color: var(--vscode-descriptionForeground); font-size: .9em; margin-top: 12px; }
</style></head><body>
  <h2>Connect SAP AI Core</h2>
  <p class="intro">Enter your SAP AI Core connection details once. They’ll be saved for next time.</p>
  <form id="form" novalidate>
    <div class="field"><label for="clientId">Client ID</label><input id="clientId" placeholder="Client ID" autocomplete="off" required></div>
    <div class="field"><label for="clientSecret">Client secret</label><input id="clientSecret" type="password" placeholder="Client secret" autocomplete="new-password"><div class="hint" id="secretHint"></div></div>
    <div class="field"><label for="apiUrl">AI Core URL</label><input id="apiUrl" placeholder="AI Core URL" required></div>
    <div class="field"><label for="authUrl">Auth URL</label><input id="authUrl" placeholder="Auth URL" required></div>
    <div class="field"><label for="resourceGroup">Resource group</label><input id="resourceGroup" placeholder="default"></div>
    <button id="testConnectionBtn" type="submit">Save and connect</button>
    <p class="success-note">Your secret is stored securely in VS Code.</p>
  </form>
  <div id="connectionStatus" role="status"></div>
  <button id="clear" type="button" hidden>Remove saved credentials</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  byId('form').addEventListener('submit', event => {
    event.preventDefault();
    byId('testConnectionBtn').disabled = true;
    vscode.postMessage({ type: 'save', value: {
      clientId: byId('clientId').value,
      clientSecret: byId('clientSecret').value,
      apiUrl: byId('apiUrl').value,
      authUrl: byId('authUrl').value,
      resourceGroup: byId('resourceGroup').value
    }});
  });
  byId('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'config') {
      byId('clientId').value = message.value.clientId || '';
      byId('apiUrl').value = message.value.apiUrl || '';
      byId('authUrl').value = message.value.authUrl || '';
      byId('resourceGroup').value = message.value.resourceGroup || 'default';
      byId('clientSecret').value = '';
      byId('clientSecret').required = !message.value.hasSecret;
      byId('secretHint').textContent = message.value.hasSecret ? 'Saved. Leave blank to keep it.' : '';
      byId('clear').hidden = !message.value.hasSecret;
    } else if (message.type === 'status') {
      byId('connectionStatus').textContent = message.text;
      byId('connectionStatus').className = message.state || '';
      byId('testConnectionBtn').disabled = message.state === 'testing';
      byId('testConnectionBtn').textContent = message.state === 'error' ? 'Try again' : 'Save and connect';
    }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

function activate(context) {
  const provider = new SapAiCoreProvider(context);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(plug) SAPilot';
  statusBarItem.tooltip = 'Connect SAPilot to SAP AI Core.';
  statusBarItem.command = 'sap-ai-core-chat.configure';
  statusBarItem.show();
  const credentialsView = new CredentialsViewProvider(context, provider, statusBarItem);
  context.subscriptions.push(
    statusBarItem,
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand('sap-ai-core-chat.configure', () => credentialsView.openPanel())
  );
  void updateStatusBarFromSavedConnection(context, statusBarItem);
  void showWelcomeIfNeeded(context);
}

async function updateStatusBarFromSavedConnection(context, statusBarItem) {
  const config = await getConnection(context);
  const configured = config.clientId && config.clientSecret && config.apiUrl && config.authUrl;
  statusBarItem.text = configured ? '$(check) SAPilot' : '$(plug) SAPilot';
  statusBarItem.tooltip = configured
    ? 'SAP AI Core details are saved. Models reconnect automatically when selected in Copilot Chat. Click to manage.'
    : 'Click to connect SAPilot to SAP AI Core.';
}

async function showWelcomeIfNeeded(context) {
  if (context.globalState.get(WELCOME_SHOWN_KEY)) return;
  const config = await getConnection(context);
  if (config.clientId && config.clientSecret && config.apiUrl && config.authUrl) {
    await context.globalState.update(WELCOME_SHOWN_KEY, true);
    return;
  }
  try {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
    await context.globalState.update(WELCOME_SHOWN_KEY, true);
  } catch {
    // The walkthrough remains available from VS Code's Get Started page.
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
