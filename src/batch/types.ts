import type { FileStep, FileOptimizationResult } from '../utils/optimizePipeline';

export interface BatchFile {
  path:         string;    // relative to the picked folder (includes the folder name)
  size:         number;
  sql:          string;
  selected:     boolean;
  placeholders: string[];
  unsupported:  string[];  // template syntax beyond {{ var }} — file is skipped until fixed
}

export interface FileRun {
  step:        FileStep;
  startedAt?:  number;
  finishedAt?: number;
  stream:      string;      // live Gemini output while optimizing
  error?:      string;
  missing?:    string[];    // placeholders with no value (step = needs_input)
  result?:     FileOptimizationResult;
  accepted:    boolean;
}

export interface LogEntry {
  t:     number;
  file?: string;
  msg:   string;
  level: 'info' | 'ok' | 'warn' | 'error';
}
