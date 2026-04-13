import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Mandu Docs",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/aspect-build/mandu",
        },
      ],
      defaultLocale: "ko",
      locales: {
        ko: {
          label: "한국어",
          lang: "ko",
        },
        en: {
          label: "English",
          lang: "en",
        },
      },
      sidebar: [
        {
          label: "시작하기",
          translations: { en: "Getting Started" },
          autogenerate: { directory: "getting-started" },
        },
        {
          label: "핵심 개념",
          translations: { en: "Core Concepts" },
          autogenerate: { directory: "core-concepts" },
        },
        {
          label: "가이드",
          translations: { en: "Guides" },
          autogenerate: { directory: "guides" },
        },
      ],
      editLink: {
        baseUrl: "https://github.com/aspect-build/mandu/edit/main/docs-site/",
      },
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
