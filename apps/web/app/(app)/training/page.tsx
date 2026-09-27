import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function TrainingPage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.training"
            endpoint="/api/proxy/hr/training-programs"
            columns={[
                { key: 'title', label: 'Title' },
                { key: 'category', label: 'Category' },
                { key: 'provider', label: 'Provider' },
                { key: 'duration_hours', label: 'Hours' },
                { key: 'start_date', label: 'Start' },
                { key: 'end_date', label: 'End' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'title', label: 'Title' },
                { key: 'description', label: 'Description', type: 'textarea' },
                { key: 'category', label: 'Category' },
                { key: 'provider', label: 'Provider' },
                { key: 'duration_hours', label: 'Duration (hours)', type: 'number' },
                { key: 'start_date', label: 'Start Date', type: 'date' },
                { key: 'end_date', label: 'End Date', type: 'date' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['available', 'in_progress', 'completed', 'cancelled']
                }
            ]}
        />
    );
}
