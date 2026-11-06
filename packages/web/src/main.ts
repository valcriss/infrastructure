import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { PRODUCT_NAME } from "./brand";
import "./icons";
import { router } from "./router";
import { useTheme } from "./stores/theme";
import "./style.css";

const pinia = createPinia();
const app = createApp(App).use(pinia).use(router);
app.component("FaIcon", FontAwesomeIcon);
useTheme(pinia).init();
document.title = PRODUCT_NAME;
app.mount("#app");
