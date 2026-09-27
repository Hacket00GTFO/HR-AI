import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function AttendancePage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.attendance"
            endpoint="/api/proxy/hr/attendance"
            columns={[
                { key: 'employee_id', label: 'Employee ID' },
                { key: 'date', label: 'Date' },
                { key: 'check_in', label: 'Check In' },
                { key: 'check_out', label: 'Check Out' },
                { key: 'hours_worked', label: 'Hours' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'employee_id', label: 'Employee ID', type: 'number' },
                { key: 'date', label: 'Date', type: 'date' },
                { key: 'check_in', label: 'Check In', type: 'text' },
                { key: 'check_out', label: 'Check Out', type: 'text' },
                { key: 'hours_worked', label: 'Hours Worked', type: 'number' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['present', 'absent', 'late', 'remote', 'half_day']
                },
                { key: 'notes', label: 'Notes', type: 'textarea' }
            ]}
        />
    );
}
