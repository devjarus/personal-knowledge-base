import ImportForm from "@/components/import-form";

export default function ImportPage() {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Import notes</h1>
        <p className="text-muted-foreground text-sm">
          Copy markdown files from an external folder into the KB under{" "}
          <code className="mx-1">imports/</code>.
        </p>
      </div>
      <ImportForm />
    </div>
  );
}
