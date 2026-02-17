/// <reference types="vite/client" />

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "@/styles/globals.css";

declare module "@/lib/*" {
  export * from "@/lib/utils";
}