import { fontsourceFontLoader } from "metaplate/fonts";
import { createNextOg } from "metaplate/next";

export type OgCopy = {
  eyebrow: string;
  title: string;
  description: string;
  alt: string;
};

export const og = createNextOg<OgCopy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: (copy) => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: "#111",
        color: "#fff",
        padding: 72,
      }}
    >
      <span style={{ fontSize: 20 }}>{copy.eyebrow}</span>
      <span style={{ fontFamily: "Inter", fontWeight: 700, fontSize: 72 }}>
        {copy.title}
      </span>
      <span style={{ display: "flex", fontSize: 28 }}>{copy.description}</span>
    </div>
  ),
});
