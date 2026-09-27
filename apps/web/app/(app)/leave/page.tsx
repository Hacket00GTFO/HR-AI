import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function LeavePage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.leave"
            endpoint="/api/proxy/hr/leave-requests"
            columns={[
                { key: 'employee_id', label: 'Employee ID' },
                { key: 'leave_type', label: 'Type' },
                { key: 'start_date', label: 'Start' },
                { key: 'end_date', label: 'End' },
                { key: 'days', label: 'Days' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'employee_id', label: 'Employee ID', type: 'number' },
                {
                    key: 'leave_type',
                    label: 'Leave Type',
                    type: 'select',
                    options: ['vacation', 'sick', 'personal', 'maternity', 'paternity', 'unpaid']
                },
                { key: 'start_date', label: 'Start Date', type: 'date' },
                { key: 'end_date', label: 'End Date', type: 'date' },
                { key: 'days', label: 'Days', type: 'number' },
                { key: 'reason', label: 'Reason', type: 'textarea' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['pending', 'approved', 'rejected', 'cancelled']
                }
            ]}
        />
    );
}
