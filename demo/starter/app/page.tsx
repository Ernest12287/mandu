import {
  StarterPlaygroundShell,
  createInitialPlaygroundModel,
} from "../src/playground-shell";

export default function HomePage() {
  return <StarterPlaygroundShell model={createInitialPlaygroundModel()} />;
}
