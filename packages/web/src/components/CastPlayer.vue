<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

// Lecteur d'enregistrements asciinema v2 : rejoue la sortie écran d'une session de terminal.
const props = defineProps<{ cast: string }>();

interface CastHeader { width: number; height: number }
type CastEvent = [number, string, string];

const box = ref<HTMLElement | null>(null);
const speed = ref(2);
const playing = ref(false);
const done = ref(false);
const progress = ref(0);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let events: CastEvent[] = [];
let header: CastHeader = { width: 80, height: 24 };
let run = 0;

function parse(): void {
  const lines = props.cast.split("\n").filter((l) => l.trim());
  header = JSON.parse(lines[0] ?? "{}") as CastHeader;
  events = lines.slice(1).map((l) => JSON.parse(l) as CastEvent);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Les longues pauses sont abrégées : on rejoue ce qui s'est affiché, pas l'attente.
const MAX_GAP_S = 1.5;

async function play(from = 0): Promise<void> {
  const token = ++run;
  playing.value = true;
  done.value = false;
  let last = events[from - 1]?.[0] ?? 0;
  for (let i = from; i < events.length; i++) {
    const [t, kind, data] = events[i] as CastEvent;
    await sleep((Math.min(t - last, MAX_GAP_S) * 1000) / speed.value);
    if (token !== run) return;
    last = t;
    if (kind === "o") term?.write(data);
    else if (kind === "r") {
      const [c, r] = data.split("x").map(Number);
      if (c && r) term?.resize(c, r);
    }
    progress.value = Math.round(((i + 1) / events.length) * 100);
  }
  playing.value = false;
  done.value = true;
}

function restart(): void {
  run++;
  term?.reset();
  term?.resize(header.width, header.height);
  progress.value = 0;
  void play(0);
}

function pause(): void {
  run++;
  playing.value = false;
}

onMounted(async () => {
  parse();
  await nextTick();
  if (!box.value) return;
  term = new Terminal({ cols: header.width, rows: header.height, disableStdin: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", theme: { background: "#0b1220", foreground: "#e2e8f0" } });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box.value);
  void play(0);
});
onBeforeUnmount(() => {
  run++;
  term?.dispose();
});
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <button v-if="playing" class="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100" @click="pause">Pause</button>
      <button v-else-if="!done" class="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100" @click="play(Math.round((progress / 100) * events.length))">Reprendre</button>
      <button class="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100" @click="restart">Depuis le début</button>
      <label class="flex items-center gap-2">
        Vitesse
        <select v-model.number="speed" class="rounded border border-slate-300 px-2 py-1">
          <option :value="1">×1</option><option :value="2">×2</option><option :value="4">×4</option><option :value="8">×8</option>
        </select>
      </label>
      <span class="text-xs text-slate-500">{{ done ? "Terminé" : `${progress} %` }}</span>
    </div>
    <div class="overflow-auto rounded bg-[#0b1220] p-2"><div ref="box"></div></div>
  </div>
</template>
