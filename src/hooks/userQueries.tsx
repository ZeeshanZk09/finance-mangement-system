import {
  useQuery,
  useMutation,
  useQueryClient,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  createTenant,
  deleteTenant,
  getAllTenants,
  getTenantById,
  getTenantsUpdatedSince,
  updateTenant,
  tenantSanityCheck,
  exportTenantData,
} from '@/lib/server_actions/tenantActions';

// Create a client
const queryClient = new QueryClient();

function App() {
  return (
    // Provide the client to your App
    <QueryClientProvider client={queryClient}>
      <Todos />
    </QueryClientProvider>
  );
}

function Todos() {
  // Access the client
  const queryClient = useQueryClient();

  // Queries
  const query = useQuery({ queryKey: ['tenantsWithCounts'], queryFn: getAllTenants });

  // Mutations
  const mutation = useMutation({
    mutationFn: postTodo,
    onSuccess: () => {
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: ['todos'] });
    },
  });

  return (
    <div>
      <ul>
        {query.data?.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>

      <button
        onClick={() => {
          mutation.mutate({
            id: Date.now(),
            title: 'Do Laundry',
          });
        }}
      >
        Add Todo
      </button>
    </div>
  );
}

// render(<App />, document.getElementById('root'))
