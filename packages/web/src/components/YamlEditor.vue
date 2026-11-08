<script setup lang="ts">
import { yaml } from "@codemirror/lang-yaml";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ modelValue: string; readonly?: boolean; label: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const host = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        yaml(),
        EditorState.readOnly.of(!!props.readonly),
        EditorView.contentAttributes.of({ "aria-label": props.label }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  },
);

/** Place le curseur au début de la ligne (1-based) et la fait défiler dans la vue : sert à rejoindre une erreur de YAML. */
function goToLine(line: number, column = 1): void {
  if (!view) return;
  const doc = view.state.doc;
  const info = doc.line(Math.min(Math.max(1, line), doc.lines));
  const pos = Math.min(info.from + Math.max(0, column - 1), info.to);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
}
defineExpose({ goToLine });

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="host" class="overflow-hidden rounded border border-slate-300 bg-white text-sm [&_.cm-editor]:max-h-[32rem] [&_.cm-editor]:min-h-[12rem] [&_.cm-scroller]:overflow-auto"></div>
</template>
