import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function PerformancePage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.performance"
            endpoint="/api/proxy/hr/performance-reviews"
            columns={[
                { key: 'employee_id', label: 'Employee ID' },
                { key: 'review_period', label: 'Period' },
                { key: 'reviewer_id', label: 'Reviewer' },
                { key: 'rating', label: 'Rating' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'employee_id', label: 'Employee ID', type: 'number' },
                { key: 'review_period', label: 'Review Period' },
                { key: 'reviewer_id', label: 'Reviewer ID', type: 'number' },
                { key: 'rating', label: 'Rating (1-5)', type: 'number' },
                { key: 'goals', label: 'Goals', type: 'textarea' },
                { key: 'achievements', label: 'Achievements', type: 'textarea' },
                { key: 'feedback', label: 'Feedback', type: 'textarea' },
                { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['draft', 'submitted', 'reviewed', 'finalized']
                }
            ]}
        />
    );
}
