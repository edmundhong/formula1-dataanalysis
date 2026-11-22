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
    const styles = getComputedStyle(node.current);
    const accent = styles.getPropertyValue("--accent").trim();
    const text = styles.getPropertyValue("--text").trim();
    const muted = styles.getPropertyValue("--muted").trim();
    const panel = styles.getPropertyValue("--panel-alt").trim();
    const border = styles.getPropertyValue("--border").trim();
    const grid = styles.getPropertyValue("--grid").trim();
    const chart = echarts.init(node.current, undefined, { renderer: "canvas" });
    chart.setOption({
      animationDuration: 350,
      backgroundColor: "transparent",
      color: [accent, "#479eff", "#b593f5", "#df789c"],
      textStyle: {
        fontFamily: "Arial, sans-serif",
        color: muted,
        fontSize: 12,
      },
      aria: { enabled: true, decal: { show: true } },
      tooltip: {
        trigger: "axis",
        backgroundColor: panel,
        borderColor: border,
        textStyle: { color: text },
      },
      grid: { left: 52, right: 22, top: 35, bottom: 48, containLabel: false },
      legend: {
        show: true,
        top: 0,
        textStyle: { color: muted },
        itemWidth: 16,
        itemHeight: 3,
      },
      xAxis: {
        type: "value",
        nameLocation: "middle",
        nameGap: 28,
        axisLine: { lineStyle: { color: border } },
        splitLine: { show: false },
        axisLabel: { color: muted },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: grid } },
        axisLabel: { color: muted },
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
