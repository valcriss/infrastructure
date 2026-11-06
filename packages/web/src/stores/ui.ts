import { defineStore } from "pinia";

const KEY = "console.sidebar";

export const useUi = defineStore("ui", {
  state: () => {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(KEY) === "collapsed";
    } catch {
      /* stockage indisponible */
    }
    return { collapsed, drawerOpen: false };
  },
  actions: {
    toggleCollapsed(): void {
      this.collapsed = !this.collapsed;
      try {
        localStorage.setItem(KEY, this.collapsed ? "collapsed" : "open");
      } catch {
        /* le choix reste valable pour cette session */
      }
    },
  },
});
