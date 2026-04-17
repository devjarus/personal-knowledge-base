import OrganizeForm from "@/components/organize-form";
import LearnForm from "@/components/learn-form";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

export default function OrganizePage() {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Organize &amp; learn</h1>
        <p className="text-muted-foreground text-sm">
          Auto-group notes into topical folders and generate per-cluster
          summaries. Preview any plan first — nothing changes until you click
          Apply. Use Undo to reverse the last run.
        </p>
      </div>

      <Tabs defaultValue="organize">
        <TabsList>
          <TabsTrigger value="organize">Organize</TabsTrigger>
          <TabsTrigger value="learn">Learn</TabsTrigger>
        </TabsList>

        <TabsContent value="organize" className="mt-6">
          <OrganizeForm />
        </TabsContent>

        <TabsContent value="learn" className="mt-6">
          <LearnForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}
