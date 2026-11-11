import fs from 'node:fs';
import path from 'node:path';
import type { Task } from './types.ts';
import { BENCH, readJson } from './util.ts';

interface PublicManifest {
  dataset: string;
  split: string;
  tasks: Array<Omit<Task, 'title'> & { instance_id: string; repo: string; base_commit: string; difficulty: string }>;
}

export function loadCustomTasks(): Task[] {
  const root = path.join(BENCH, 'tasks', 'custom');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'task.json')))
    .map(d => ({ ...readJson<Task>(path.join(root, d.name, 'task.json')), dir: path.join(root, d.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadPublicManifest(): PublicManifest | null {
  const p = path.join(BENCH, 'tasks', 'public', 'manifest.json');
  return fs.existsSync(p) ? readJson<PublicManifest>(p) : null;
}

export function loadPublicTasks(): Task[] {
  const m = loadPublicManifest();
  if (!m) return [];
  return m.tasks.map(t => ({ ...t, title: `${t.repo} ${t.instance_id} (${t.difficulty})` }));
}

export function loadTasks(filter: { levels?: string[]; ids?: string[]; sources?: string[] }): Task[] {
  return [...loadCustomTasks(), ...loadPublicTasks()].filter(t =>
    (!filter.levels || filter.levels.includes(t.level)) &&
    (!filter.ids || filter.ids.includes(t.id)) &&
    (!filter.sources || filter.sources.includes(t.source)));
}
