import { config } from '../config.js';
import { callControlTools } from './callControl.js';
import { calculatorTool } from './calculator.js';
import { BlessingCatalog, blessingTools, type Blessing } from './blessings.js';
import { demoTools } from './demo.js';
import { ToolRegistry, type ToolDefinition } from './registry.js';

export interface RegistryOptions {
  /** Notified for every blessing served, so the audit can check the transcript. */
  onBlessingServed?: (blessing: Blessing) => void;
}

/** Loaded once at startup: a broken catalogue should fail loudly, not per call. */
const catalog = BlessingCatalog.load(config.blessings.file ?? undefined);

export function buildRegistry(opts: RegistryOptions = {}): ToolRegistry {
  return new ToolRegistry(config.tools.defaultTimeoutMs)
    .registerAll(callControlTools({ defaultAgentExtension: config.tools.agentExtension }))
    .register(calculatorTool)
    .registerAll(
      blessingTools({
        catalog,
        ...(opts.onBlessingServed ? { onServed: opts.onBlessingServed } : {}),
      }),
    )
    .registerAll(demoTools);
}

export { catalog as blessingCatalog };
export type { ToolDefinition };
export * from './registry.js';
