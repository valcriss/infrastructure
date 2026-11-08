<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Container } from "../api";
import { describeError } from "../api";
import { useSession } from "../stores/session";

// Terminal interactif dans un conteneur de l'application : WebSocket vers la console, qui relaie vers l'agent.
const props = defineProps<{ hostId: string; containers: Container[] }>();
const session = useSession();

const running = computed(() => props.containers.filter((c) => c.state === "running"));
const label = (c: Container): string => c.composeService ?? c.names[0] ?? c.id.slice(0, 12);
const selected = ref("");
watch(running, (list) => { if (!list.some((c) => c.id === selected.value)) selected.value = list[0]?.id ?? ""; }, { immediate: true });

type Status = "idle" | "connecting" | "open" | "ended";
const status = ref<Status>("idle");
const notice = ref("");
const errorCode = ref("");
const banner = ref("");
const stepCode = ref("");
const stepBusy = ref(false);
const box = ref<HTMLElement | null>(null);

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let observer: ResizeObserver | null = null;

const encode = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function dispose() {
  observer?.disconnect();
  observer = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  term?.dispose();
  term = null;
  fit = null;
}

async function connect() {
  dispose();
  notice.value = errorCode.value = banner.value = "";
  if (!selected.value) return;
  status.value = "connecting";
  await nextTick();
  if (!box.value) return;
  const isDark = document.documentElement.classList.contains("dark");
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    theme: isDark ? { background: "#0b1220", foreground: "#e2e8f0" } : { background: "#0b1220", foreground: "#e2e8f0" },
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box.value);
  fit.fit();
  term.focus();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/api/v1/hosts/${props.hostId}/containers/${selected.value}/terminal?cols=${term.cols}&rows=${term.rows}`);
  ws = socket;
  term.onData((d) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: "input", d: encode(d) })));
  term.onResize(({ cols, rows }) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: "resize", cols, rows })));
  observer = new ResizeObserver(() => fit?.fit());
  observer.observe(box.value);

  socket.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { t: string; d?: string; reason?: string; exitCode?: number; code?: string; message?: string; recorded?: boolean; idleMinutes?: number; maxMinutes?: number };
    if (m.t === "ready") {
      status.value = "open";
      banner.value = `${m.recorded ? "Session enregistrée · " : ""}fermeture après ${m.idleMinutes} min d'inactivité ou ${m.maxMinutes} min au total`;
    } else if (m.t === "data" && m.d) term?.write(decode(m.d));
    else if (m.t === "end") {
      status.value = "ended";
      notice.value = `${m.reason ?? "Session terminée."}${m.exitCode !== undefined ? ` (code ${m.exitCode})` : ""}`;
    } else if (m.t === "error") {
      status.value = "ended";
      errorCode.value = m.code ?? "";
      notice.value = m.message ?? "Terminal refusé.";
    }
  };
  socket.onclose = () => {
    if (status.value === "connecting" || status.value === "open") {
      status.value = "ended";
      notice.value ||= "Connexion fermée.";
    }
  };
}

async function stepUp(kind: "code" | "passkey") {
  stepBusy.value = true;
  try {
    if (kind === "code") await session.stepUpWithCode(stepCode.value);
    else await session.stepUpWithPasskey();
    stepCode.value = "";
    await connect();
  } catch (err) {
    notice.value = describeError(err);
  } finally {
    stepBusy.value = false;
  }
}

function close() {
  ws?.send(JSON.stringify({ t: "input", d: encode("exit\n") }));
  dispose();
  status.value = "idle";
}

onBeforeUnmount(dispose);
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-end gap-3 text-sm">
      <label class="block">
        <span class="font-medium">Conteneur</span>
        <select v-model="selected" :disabled="status === 'connecting' || status === 'open'" class="mt-1 block rounded border border-slate-300 px-3 py-2">
          <option v-for="c in running" :key="c.id" :value="c.id">{{ label(c) }}</option>
        </select>
      </label>
      <button v-if="status !== 'open' && status !== 'connecting'" :disabled="!selected" class="rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50" @click="connect">
        {{ status === "ended" ? "Rouvrir un terminal" : "Ouvrir un terminal" }}
      </button>
      <button v-else class="rounded border border-slate-300 px-3 py-2 hover:bg-slate-100" @click="close">Fermer le terminal</button>
      <span v-if="banner" class="text-xs text-slate-500">{{ banner }}</span>
    </div>
    <p v-if="!running.length" class="text-sm text-slate-500">Aucun conteneur en marche : un terminal ne peut s'ouvrir que dans un conteneur démarré.</p>

    <div v-if="notice" :class="['rounded border p-3 text-sm', errorCode ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-700']" role="status">
      <p>{{ notice }}</p>
      <form v-if="errorCode === 'step_up_required'" class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="stepUp('code')">
        <input v-model="stepCode" inputmode="numeric" autocomplete="one-time-code" placeholder="Code à usage unique" required class="w-48 rounded border border-slate-300 px-3 py-2 text-sm text-slate-900" />
        <button :disabled="stepBusy" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">Confirmer</button>
        <button v-if="session.info?.passkeysAvailable" type="button" :disabled="stepBusy" class="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-white disabled:opacity-50" @click="stepUp('passkey')">Utiliser une clé d'accès</button>
      </form>
      <RouterLink v-if="errorCode === 'mfa_not_enrolled'" to="/account" class="mt-2 inline-block underline">Ouvrir « Mon compte »</RouterLink>
    </div>

    <div v-show="status === 'connecting' || status === 'open' || (status === 'ended' && !errorCode)" ref="box" class="h-[calc(100dvh-24rem)] min-h-64 overflow-hidden rounded bg-[#0b1220] p-2"></div>
    <p class="text-xs text-slate-500">
      Le terminal ouvre un nouveau shell dans le conteneur (bash s'il existe, sinon sh). Les images sans shell ne sont pas utilisables. Les sessions sont tracées dans l'audit
      <template v-if="session.isAdmin">et peuvent être rejouées depuis Paramètres → Terminal</template>.
    </p>
  </div>
</template>
