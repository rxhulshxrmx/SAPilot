// Provider routing adapted from Couplet's SAP AI Core transport layer.
// Keep this file dependency-free so it ships with the standalone VS Code VSIX.
const CHAT_EXECUTABLES = new Set([
  'azure-openai', 'aicore-opensource', 'aicore-mistralai', 'aicore-ibm',
  'aicore-cohere', 'gcp-vertexai', 'aws-bedrock', 'perplexity-ai'
]);
const NON_CHAT_MARKERS = [
  'embedding', 'embedqa', 'rerank', 'reranker', 're-rank', 'tabular',
  'sap-rpt', 'classifier', 'classification'
];

function transportForDeployment(executableId, modelName) {
  const executable = String(executableId || '').toLowerCase();
  const model = String(modelName || '').toLowerCase();
  if (model.includes('gpt') && model.includes('realtime')) return 'unsupported';
  if (executable === 'aicore-nvidia' || executable === 'aicore-sap' || executable === 'orchestration' ||
      NON_CHAT_MARKERS.some(marker => model.includes(marker))) return 'unsupported';
  if (model.includes('nova')) return 'bedrock-converse';
  if (executable && !CHAT_EXECUTABLES.has(executable)) return 'unsupported';
  if (executable === 'aicore-cohere' || model.includes('cohere')) return 'cohere-chat';
  if (executable === 'gcp-vertexai' || model.includes('gemini')) return 'vertex-generate';
  if (model.includes('anthropic') || model.includes('claude')) return 'anthropic-invoke';
  if (executable === 'aws-bedrock') return 'bedrock-converse';
  return 'chat-completions';
}

function endpointForDeployment(baseUrl, transport, executableId, modelName, apiVersion) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const path = transport === 'anthropic-invoke' ? 'invoke'
    : transport === 'bedrock-converse' ? 'converse'
      : transport === 'cohere-chat' ? 'v2/chat'
        : transport === 'vertex-generate' ? `models/${encodeURIComponent(modelName)}:generateContent`
          : 'chat/completions';
  const url = new URL(`${base}/${path}`);
  const executable = String(executableId || '').toLowerCase();
  const addApiVersion = executable ? executable === 'azure-openai' : transport === 'chat-completions';
  if (addApiVersion && !url.searchParams.has('api-version')) url.searchParams.set('api-version', apiVersion);
  return url.toString();
}

function buildRequest(transport, modelName, messages, tools) {
  const toolDefinitions = tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description || '', parameters: tool.inputSchema || { type: 'object' } }
  }));
  if (transport === 'chat-completions') {
    const body = { model: modelName, messages, stream: true };
    if (toolDefinitions.length) { body.tools = toolDefinitions; body.tool_choice = 'auto'; }
    return { body, streaming: true };
  }
  if (transport === 'anthropic-invoke') return { body: buildAnthropicRequest(messages, tools), streaming: false };
  if (transport === 'bedrock-converse') return { body: buildConverseRequest(messages, tools), streaming: false };
  if (transport === 'cohere-chat') return { body: { model: modelName, messages, stream: false, ...(toolDefinitions.length ? { tools: toolDefinitions } : {}) }, streaming: false };
  if (transport === 'vertex-generate') return { body: buildVertexRequest(messages, tools), streaming: false };
  throw new Error(`SAP AI Core deployment "${modelName}" is not supported for chat.`);
}

function buildAnthropicRequest(messages, tools) {
  const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).filter(Boolean).join('\n\n');
  const conversation = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      appendToPreviousUser(conversation, { type: 'tool_result', tool_use_id: message.tool_call_id || 'unknown-tool-call', content: textOf(message.content) }, true);
      continue;
    }
    const blocks = textOf(message.content) ? [{ type: 'text', text: textOf(message.content) }] : [];
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) blocks.push({
        type: 'tool_use', id: call.id || 'unknown-tool-call', name: call.function.name,
        input: parseArguments(call.function.arguments)
      });
    }
    conversation.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks.length ? blocks : '' });
  }
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, messages: conversation };
  if (system) body.system = system;
  if (tools.length) body.tools = tools.map(tool => ({ name: tool.name, description: tool.description || '', input_schema: tool.inputSchema || { type: 'object' } }));
  return body;
}

function buildConverseRequest(messages, tools) {
  const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).filter(Boolean).map(text => ({ text }));
  const conversation = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      appendToPreviousUser(conversation, { toolResult: {
        toolUseId: message.tool_call_id || 'unknown-tool-call', content: [{ text: textOf(message.content) }], status: 'success'
      } });
      continue;
    }
    const content = textOf(message.content) ? [{ text: textOf(message.content) }] : [];
    if (message.role === 'assistant') for (const call of message.tool_calls || []) content.push({ toolUse: {
      toolUseId: call.id || 'unknown-tool-call', name: call.function.name, input: parseArguments(call.function.arguments)
    } });
    conversation.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: content.length ? content : [{ text: '' }] });
  }
  const body = { messages: conversation, inferenceConfig: { maxTokens: 4096 } };
  if (system.length) body.system = system;
  if (tools.length) body.toolConfig = {
    tools: tools.map(tool => ({ toolSpec: { name: tool.name, description: tool.description || '', inputSchema: { json: tool.inputSchema || { type: 'object' } } } })),
    toolChoice: { auto: {} }
  };
  return body;
}

function buildVertexRequest(messages, tools) {
  const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).filter(Boolean).map(text => ({ text }));
  const conversation = [];
  const toolNames = new Map();
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const name = toolNames.get(message.tool_call_id || '') || 'tool';
      const response = { functionResponse: { name, response: { result: textOf(message.content) } } };
      const previous = conversation[conversation.length - 1];
      if (previous && previous.role === 'user') previous.parts.push(response);
      else conversation.push({ role: 'user', parts: [response] });
      continue;
    }
    const parts = textOf(message.content) ? [{ text: textOf(message.content) }] : [];
    if (message.role === 'assistant') for (const call of message.tool_calls || []) {
      toolNames.set(call.id, call.function.name);
      parts.push({ functionCall: { name: call.function.name, args: parseArguments(call.function.arguments) } });
    }
    conversation.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: parts.length ? parts : [{ text: '' }] });
  }
  const body = { contents: conversation, generationConfig: { maxOutputTokens: 4096 } };
  if (system.length) body.systemInstruction = { parts: system };
  if (tools.length) body.tools = [{ functionDeclarations: tools.map(tool => ({
    name: tool.name, description: tool.description || '', parameters: tool.inputSchema || { type: 'object' }
  })) }];
  return body;
}

function appendToPreviousUser(conversation, block, anthropic = false) {
  const previous = conversation[conversation.length - 1];
  if (previous && previous.role === 'user') {
    if (anthropic && Array.isArray(previous.content)) previous.content.push(block);
    else if (Array.isArray(previous.content)) previous.content.push(block);
    else previous.content = [previous.content, block];
  } else conversation.push({ role: 'user', content: anthropic ? [block] : [block] });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '').join('');
}

function parseArguments(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return { raw_arguments: raw }; }
}

function parseResponse(transport, payload) {
  let text = '';
  const toolCalls = [];
  let blocks;
  if (transport === 'anthropic-invoke') blocks = payload && payload.content;
  else if (transport === 'bedrock-converse') blocks = payload && payload.output && payload.output.message && payload.output.message.content;
  else if (transport === 'vertex-generate') blocks = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts;
  else if (transport === 'cohere-chat') {
    const message = payload && payload.message;
    if (typeof (message && message.content) === 'string') text = message.content;
    else if (Array.isArray(message && message.content)) text = message.content.map(part => part && part.text || '').join('');
    for (const call of message && message.tool_calls || []) addToolCall(toolCalls, call.id, call.function && call.function.name, call.function && call.function.arguments);
  }
  if (Array.isArray(blocks)) for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (transport === 'anthropic-invoke') {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'tool_use') addToolCall(toolCalls, block.id, block.name, block.input);
    } else if (transport === 'bedrock-converse') {
      if (typeof block.text === 'string') text += block.text;
      if (block.toolUse) addToolCall(toolCalls, block.toolUse.toolUseId, block.toolUse.name, block.toolUse.input);
    } else if (transport === 'vertex-generate') {
      if (typeof block.text === 'string') text += block.text;
      if (block.functionCall) addToolCall(toolCalls, `vertex-${toolCalls.length + 1}`, block.functionCall.name, block.functionCall.args);
    }
  }
  return { text, toolCalls };
}

function addToolCall(target, id, name, args) {
  if (!name) return;
  target.push({ id: typeof id === 'string' ? id : `tool-${target.length + 1}`, name, input: typeof args === 'string' ? parseArguments(args) : args || {} });
}

module.exports = { transportForDeployment, endpointForDeployment, buildRequest, parseResponse };
