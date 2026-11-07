// examples/api/remote-avatar.tsx
import { RemoteImageError, remoteImageLoader } from "metaplate/assets";
import { fontsourceFontLoader } from "metaplate/fonts";
import { createNodeOg } from "metaplate/node";

type Copy = { name: string; avatar: string; alt: string };

const avatars = remoteImageLoader({ origins: ["https://avatars.example.com"] });

/** A missing avatar should not fail the build. A wrong allowlist should. */
async function avatarOrNothing(url: string) {
  try {
    return await avatars(url);
  } catch (error) {
    if (error instanceof RemoteImageError && error.code !== "origin") {
      console.warn(`No avatar for this card: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

export const og = createNodeOg<Copy>({
  alt: (copy) => copy.alt,
  fonts: fontsourceFontLoader([{ font: "inter", weight: 700 }]),
  component: async (copy) => {
    const avatar = await avatarOrNothing(copy.avatar);
    return (
      <div
        style={{
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 40,
          padding: 72,
          background: "#111",
          color: "#fff",
          fontFamily: "Inter",
          fontSize: 64,
        }}
      >
        {avatar ? (
          <img src={avatar.src} width={160} height={160} style={{ borderRadius: 80 }} />
        ) : (
          <div style={{ display: "flex", width: 160, height: 160, borderRadius: 80, background: "#345" }} />
        )}
        {copy.name}
      </div>
    );
  },
});
