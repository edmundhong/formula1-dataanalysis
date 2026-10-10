"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import {
  LineChart,
  BarChart,
  CustomChart,
  ScatterChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  AriaComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
echarts.use([
  LineChart,
  BarChart,
  CustomChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  AriaComponent,
  CanvasRenderer,
]);

export default function Chart({
  option,
  theme,
  height = 290,
  group,
  label,
  onDistanceHover,
}: {
  option: object;
  theme: string;
  height?: number;
  group?: string;
  label: string;
  onDistanceHover?: (distance: number | null) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const hoverCallback = useRef(onDistanceHover);
  useEffect(() => { hoverCallback.current = onDistanceHover; }, [onDistanceHover]);
  useEffect(() => {
    if (!node.current) return;
    const dark = theme === "dark";
    const chart = echarts.init(node.current, undefined, { renderer: "canvas" });
    chart.setOption({
      animationDuration: 350,
      backgroundColor: "transparent",
      color: ["#ff5b55", "#479eff", "#40c6a1", "#b593f5"],
      textStyle: {
        fontFamily: "Arial, sans-serif",
        color: dark ? "#a6adbd" : "#606779",
        fontSize: 12,
      },
      aria: { enabled: true, decal: { show: true } },
      tooltip: {
        trigger: "axis",
        backgroundColor: dark ? "#20252e" : "#fff",
        borderColor: dark ? "#383f4b" : "#d9dee7",
        textStyle: { color: dark ? "#edf0f5" : "#18202b" },
      },
      grid: { left: 52, right: 22, top: 35, bottom: 48, containLabel: false },
      legend: {
        show: true,
        top: 0,
        textStyle: { color: dark ? "#b8c0cc" : "#49505d" },
        itemWidth: 16,
        itemHeight: 3,
      },
      xAxis: {
        type: "value",
        nameLocation: "middle",
        nameGap: 28,
        axisLine: { lineStyle: { color: dark ? "#363c48" : "#d4d9e3" } },
        splitLine: { show: false },
        axisLabel: { color: dark ? "#969eaf" : "#606779" },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: dark ? "#272d37" : "#edf0f5" } },
        axisLabel: { color: dark ? "#969eaf" : "#606779" },
      },
    });
    // Merge axis overrides into the defaults, preserving scale and theme styling.
    chart.setOption(option as EChartsOption);
    chart.on("updateAxisPointer", (event: unknown) => {
      const axis = (event as { axesInfo?: { axisDim: string; value: number }[] })
        .axesInfo?.find((axis) => axis.axisDim === "x");
      hoverCallback.current?.(axis && Number.isFinite(axis.value) ? axis.value : null);
    });
    const clearHover = () => hoverCallback.current?.(null);
    chart.getZr().on("globalout", clearHover);
    if (group) {
      chart.group = group;
      echarts.connect(group);
    }
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(node.current);
    return () => {
      observer.disconnect();
      clearHover();
      chart.dispose();
    };
  }, [option, theme, group]);
  return (
    <div
      ref={node}
      className="chart"
      style={{ height }}
      role="img"
      aria-label={label}
    />
  );
}
