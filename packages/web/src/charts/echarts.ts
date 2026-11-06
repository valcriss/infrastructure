import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

// Seuls les types de graphiques utilisés sont embarqués ; ce module est chargé à la demande
// (voir BaseChart.vue), pour ne pas alourdir les pages sans graphique.
echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer]);

export { echarts };
