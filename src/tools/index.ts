import { config } from '../config.js';
import { callControlTools } from './callControl.js';
import { demoTools } from './demo.js';
import { ToolRegistry } from './registry.js';

export function buildRegistry(): ToolRegistry {
  return new ToolRegistry(config.tools.defaultTimeoutMs)
    .registerAll(callControlTools({ defaultAgentExtension: process.env.AGENT_EXTENSION?.trim() || '/2' }))
    .registerAll(demoTools);
}

export * from './registry.js';
