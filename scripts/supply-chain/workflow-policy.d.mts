export function listWorkflowFiles(directory?: string): string[];
export function workflowPinErrors(source: string, label: string): string[];
export function lifecycleScriptErrors(source: string, label: string): string[];
export function validateWorkflows(files?: readonly string[]): string[];
export function lifecycleScriptsDisabledInCi(files?: readonly string[]): boolean;
