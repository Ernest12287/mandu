interface ErrorPageProps {
  error: Error;
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <div className="text-center py-16">
      <div className="text-4xl mb-4">!</div>
      <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
      <p className="text-sm text-gray-500 mb-6">{error.message}</p>
      <button
        onClick={reset}
        className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800"
      >
        Try again
      </button>
    </div>
  );
}
