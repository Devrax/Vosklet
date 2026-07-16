let loadScript;

function getLoader() {
  if (typeof globalThis.loadVosklet === "function") {
    return Promise.resolve(globalThis.loadVosklet);
  }

  if (typeof document === "undefined") {
    return Promise.reject(
      new Error("Vosklet can only be loaded in a browser context.")
    );
  }

  if (!loadScript) {
    loadScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("./Vosklet.single.js", import.meta.url).href;
      script.async = true;
      script.onload = () => {
        if (typeof globalThis.loadVosklet === "function") {
          resolve(globalThis.loadVosklet);
          return;
        }
        reject(new Error("Vosklet did not expose loadVosklet."));
      };
      script.onerror = () => reject(new Error("Unable to load Vosklet."));
      document.head.append(script);
    });
  }

  return loadScript;
}

export async function loadVosklet(moduleArg) {
  const loader = await getLoader();
  return loader(moduleArg);
}