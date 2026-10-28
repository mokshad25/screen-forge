import { OperatorConsole } from "@/components/OperatorConsole";

// Optional link parameters, so a specific screen can be opened directly
// (checkpoint screenshots, demo fallback):
//   ?golden=status-alarms|trend|comms  ?panel=small|medium|large  ?view=single|side-by-side
export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const pick = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : undefined;
  };
  return <OperatorConsole initialGolden={pick("golden")} initialPanel={pick("panel")} initialView={pick("view")} />;
}
